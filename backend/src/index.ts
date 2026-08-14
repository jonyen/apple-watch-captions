import { join } from "path";
import { mkdirSync, readdirSync, statSync, existsSync } from "fs";
import { createClient } from "@deepgram/sdk";
import { loadConfig } from "./config";
import { startServer, ProviderOptions } from "./server";
import { openDb } from "./db";
import { IdentityStore } from "./identityStore";
import { DeepgramProvider, DeepgramLike, telephonyOptions } from "./deepgramProvider";
import { OpenAIProvider } from "./openaiProvider";
import { AssemblyAIProvider } from "./assemblyaiProvider";
import { ChannelSplitProvider } from "./channelSplitProvider";
import { UnavailableProvider } from "./unavailableProvider";
import { TranscriptionProvider } from "./transcriptionProvider";
import { TranscriptStore } from "./transcriptStore";
import { Summarize, createClaudeSummarizer } from "./summarizer";
import { createGeminiSummarizer } from "./geminiSummarizer";
import { createFinalizer } from "./finalizer";
import { createNotionExporter, createNotionSummaryPatcher } from "./notionExporter";
import { backfillNotion } from "./notionBackfill";
import { backfillSummaries } from "./summaryBackfill";
import { createNotionUpdater } from "./notionUpdater";
import { createUsageService } from "./usageService";
import { migrateFlatTranscripts } from "./tenantMigration";

const config = loadConfig(process.env);
const deepgram = createClient(config.deepgramApiKey) as unknown as DeepgramLike;

/**
 * Pick the summarizer backend: an explicit SUMMARY_PROVIDER wins, otherwise
 * whichever key is configured (Claude first, since it is the better model).
 */
function chooseSummarizer(): Summarize | undefined {
  const wanted =
    config.summaryProvider ??
    (config.anthropicApiKey ? "claude" : config.geminiApiKey ? "gemini" : undefined);

  if (wanted === "claude") {
    if (config.anthropicApiKey) return createClaudeSummarizer(config.anthropicApiKey);
    console.warn("SUMMARY_PROVIDER=claude but ANTHROPIC_API_KEY is not set");
  } else if (wanted === "gemini") {
    if (config.geminiApiKey) return createGeminiSummarizer(config.geminiApiKey);
    console.warn("SUMMARY_PROVIDER=gemini but GEMINI_API_KEY is not set");
  }
  return undefined;
}

const summarize = chooseSummarizer();
console.log(
  summarize
    ? `Summaries via ${config.summaryProvider ?? (config.anthropicApiKey ? "claude" : "gemini")}`
    : "No summary provider configured — transcripts are saved without summaries",
);

const exportTranscript = config.notion ? createNotionExporter(config.notion) : undefined;
if (!exportTranscript) {
  console.log("NOTION_TOKEN/NOTION_DATABASE_ID not set — transcripts are not exported to Notion");
}

const transcripts = new TranscriptStore({
  root: config.transcriptsDir,
  onFinalize: createFinalizer({
    root: config.transcriptsDir,
    summarize,
    export: exportTranscript,
    update: config.notion ? createNotionUpdater(config.notion) : undefined,
  }),
});

/**
 * Deepgram transcribes the 2-channel stream natively; OpenAI and AssemblyAI
 * are mono-only, so dual-channel sessions get a ChannelSplitProvider running
 * one upstream connection per channel.
 */
function createProvider(opts?: ProviderOptions): TranscriptionProvider {
  const dual = opts?.channels === 2;
  const monoOnly = (
    name: string,
    apiKey: string | undefined,
    make: (key: string) => TranscriptionProvider,
  ): TranscriptionProvider => {
    if (!apiKey) {
      return new UnavailableProvider(`${name} is not configured on the relay`);
    }
    return dual ? new ChannelSplitProvider(() => make(apiKey)) : make(apiKey);
  };

  switch (opts?.provider) {
    case "openai":
      return monoOnly("OpenAI", config.openaiApiKey, (key) => new OpenAIProvider(key));
    case "assemblyai":
      return monoOnly("AssemblyAI", config.assemblyaiApiKey, (key) => new AssemblyAIProvider(key));
    default:
      // Telephony is mono by definition — one caller, one track — so it never
      // combines with the dual-channel path.
      if (opts?.telephony) {
        return new DeepgramProvider(deepgram, telephonyOptions(config.deepgramPhoneModel));
      }
      return new DeepgramProvider(
        deepgram,
        dual ? { channels: 2, multichannel: true } : undefined,
      );
  }
}

// The directory has to exist before `openDb` runs: nothing else creates it
// this early (TranscriptStore only creates it lazily, on the first write),
// so on a fresh volume `openDb` would otherwise throw SQLITE_CANTOPEN at
// import time and boot-loop the process. `dbPath` defaults beside the
// transcripts on the same persistent volume, so identities survive a
// redeploy; an in-memory store here would force every device to re-register.
mkdirSync(config.transcriptsDir, { recursive: true });
const identity = new IdentityStore(openDb(config.dbPath));

// One-time (per install) adoption of transcripts written before the relay was
// multi-tenant. No-ops on every boot after the first, once the flat root
// holds only per-user directories.
const migrated = migrateFlatTranscripts(config.transcriptsDir, identity);
if (migrated) {
  console.log(
    `Migrated ${migrated.moved} file(s) to user ${migrated.userId}. ` +
      `Adopt existing installs with this token (shown once): ${migrated.token}`,
  );
}

const server = startServer({
  port: config.port,
  identity,
  adminToken: config.adminToken,
  createProvider,
  transcripts,
  transcriptsRoot: config.transcriptsDir,
  usage: createUsageService({ env: process.env }),
  callForwardTo: config.twilioForwardTo,
});

const addr = server.address();
const port = typeof addr === "object" && addr ? addr.port : config.port;
console.log(`Caption relay listening on ws://0.0.0.0:${port}/stream`);
console.log(`Transcripts in ${config.transcriptsDir}; viewer at /app`);

/**
 * The per-user subdirectories under the transcripts root — each backfill
 * sweep runs once per user rather than once over the (now-empty, once
 * migration has run) flat root, since transcripts live under
 * `userDir(root, userId)` rather than directly in `root`.
 */
function userDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((entry) => statSync(join(root, entry)).isDirectory())
    .map((entry) => join(root, entry));
}

/**
 * Catch up on stored transcripts: summarize any that never got one (the key
 * was unset, out of credit, or erroring at the time), then export anything
 * that never reached Notion. Summaries run first so a transcript exported in
 * the same sweep carries its summary.
 *
 * Runs once per user directory and sums the results, rather than once over
 * the flat root: transcripts live under `userDir(root, userId)` now, so a
 * single sweep of the root itself would see no `.jsonl` files and do
 * nothing.
 */
async function runBackfills(): Promise<void> {
  const dirs = userDirs(config.transcriptsDir);

  if (summarize) {
    const totals = { summarized: 0, patched: 0, failed: 0 };
    for (const dir of dirs) {
      const r = await backfillSummaries({
        dir,
        summarize,
        patchPage: config.notion ? createNotionSummaryPatcher(config.notion) : undefined,
      });
      totals.summarized += r.summarized;
      totals.patched += r.patched;
      totals.failed += r.failed;
    }
    if (totals.summarized || totals.failed) {
      console.log(
        `Summary backfill: ${totals.summarized} written, ${totals.patched} added to Notion, ${totals.failed} failed`,
      );
    }
  }
  if (exportTranscript) {
    const totals = { exported: 0, failed: 0 };
    for (const dir of dirs) {
      const r = await backfillNotion({ dir, export: exportTranscript });
      totals.exported += r.exported;
      totals.failed += r.failed;
    }
    if (totals.exported || totals.failed) {
      console.log(`Notion backfill: ${totals.exported} exported, ${totals.failed} failed`);
    }
  }
}

void runBackfills().catch((err) => console.error("backfill failed:", err));
