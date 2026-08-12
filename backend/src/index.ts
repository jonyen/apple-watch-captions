import { join } from "path";
import { createClient } from "@deepgram/sdk";
import { loadConfig } from "./config";
import { startServer, ProviderOptions } from "./server";
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
  dir: config.transcriptsDir,
  onFinalize: createFinalizer({
    dir: config.transcriptsDir,
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

const server = startServer({
  port: config.port,
  authToken: config.authToken,
  createProvider,
  transcripts,
  transcriptsDir: config.transcriptsDir,
  usage: createUsageService({ env: process.env }),
  callForwardTo: config.twilioForwardTo,
  // Beside the transcripts, so settings ride the same persistent volume and
  // survive a deploy — a caption size that reset itself on every release would
  // read as a bug in the watch app.
  settingsFile: join(config.transcriptsDir, "settings.json"),
});

const addr = server.address();
const port = typeof addr === "object" && addr ? addr.port : config.port;
console.log(`Caption relay listening on ws://0.0.0.0:${port}/stream`);
console.log(`Transcripts in ${config.transcriptsDir}; viewer at /app`);

/**
 * Catch up on stored transcripts: summarize any that never got one (the key
 * was unset, out of credit, or erroring at the time), then export anything
 * that never reached Notion. Summaries run first so a transcript exported in
 * the same sweep carries its summary.
 */
async function runBackfills(): Promise<void> {
  if (summarize) {
    const r = await backfillSummaries({
      dir: config.transcriptsDir,
      summarize,
      patchPage: config.notion ? createNotionSummaryPatcher(config.notion) : undefined,
    });
    if (r.summarized || r.failed) {
      console.log(
        `Summary backfill: ${r.summarized} written, ${r.patched} added to Notion, ${r.failed} failed`,
      );
    }
  }
  if (exportTranscript) {
    const r = await backfillNotion({ dir: config.transcriptsDir, export: exportTranscript });
    if (r.exported || r.failed) {
      console.log(`Notion backfill: ${r.exported} exported, ${r.failed} failed`);
    }
  }
}

void runBackfills().catch((err) => console.error("backfill failed:", err));
