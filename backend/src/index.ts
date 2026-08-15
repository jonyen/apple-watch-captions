import { dirname } from "path";
import { mkdirSync } from "fs";
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
import { backfillNotion } from "./notionBackfill";
import { backfillSummaries } from "./summaryBackfill";
import { createUsageService } from "./usageService";
import { migrateFlatTranscripts } from "./tenantMigration";
import { adoptLegacyNotionAtBoot } from "./exportDestinations";
import { buildServerOptions, buildResolveExporters } from "./serverOptions";
import { chooseSummarizer } from "./chooseSummarizer";
import { userDirs } from "./userDirs";

const config = loadConfig(process.env);
const deepgram = createClient(config.deepgramApiKey) as unknown as DeepgramLike;

const summarize = chooseSummarizer(config);
console.log(
  summarize
    ? `Summaries via ${config.summaryProvider ?? (config.anthropicApiKey ? "claude" : "gemini")}`
    : "No summary provider configured — transcripts are saved without summaries",
);

// The directory has to exist before `openDb` runs: nothing else creates it
// this early (TranscriptStore only creates it lazily, on the first write),
// so on a fresh volume `openDb` would otherwise throw SQLITE_CANTOPEN at
// import time and boot-loop the process. `dbPath` defaults beside the
// transcripts on the same persistent volume, so identities survive a
// redeploy; an in-memory store here would force every device to re-register.
mkdirSync(config.transcriptsDir, { recursive: true });
// And the database's own directory, which is only the same one by default: a
// DB_PATH pointed anywhere else (a sibling directory on the volume, say) that
// does not exist yet fails with SQLITE_CANTOPEN at import time, which on Fly
// is a boot loop rather than an error anyone reads.
mkdirSync(dirname(config.dbPath), { recursive: true });
const db = openDb(config.dbPath);
const identity = new IdentityStore(db);

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

// `buildServerOptions` is the actual gating logic (see serverOptions.ts for
// why it lives there rather than inline here): every optional piece is
// constructed from `config` and gated on what actually makes it usable, so
// an unconfigured relay still boots and captions normally. The console
// output below is derived from the *returned* options object rather than
// re-checking each config flag separately, so a log line can never claim a
// wiring state that isn't the one actually passed to `startServer` (fix
// round 1, Critical 2 was exactly this kind of drift — a comment asserting a
// fallback that didn't exist).
const options = buildServerOptions(config, {
  db,
  identity,
  createProvider,
  summarize,
  usage: createUsageService({ env: process.env }),
});

if (!options.destinations) {
  console.log("Export destinations disabled: ENCRYPTION_KEY is not set");
}
if (!options.sendEmail) {
  console.log("Transcript email disabled: RESEND_API_KEY and EMAIL_FROM are not both set");
}
if (!config.notionOAuth) {
  console.log(
    "Per-user Notion export disabled: set NOTION_CLIENT_ID, NOTION_CLIENT_SECRET, and PUBLIC_BASE_URL",
  );
} else if (!options.oauthStates) {
  // notionOAuth is set but buildServerOptions still declined to wire the
  // OAuth pieces — the only other thing it gates on is `destinations`. See
  // serverOptions.ts's "does not offer to connect Notion..." test.
  console.log(
    "Per-user Notion export disabled: ENCRYPTION_KEY is not set (Notion OAuth is otherwise configured)",
  );
}
if (options.sendEmail && !options.emailVerifications) {
  console.log("Transcript email confirmation disabled: PUBLIC_BASE_URL is not set");
}
if (config.notion) {
  // The old single-workspace NOTION_TOKEN/NOTION_DATABASE_ID path is
  // deprecated now that each user connects their own workspace — this is
  // the operator-visible replacement for the "NOTION_TOKEN not set" line
  // Task 4 removed, so upgrading with a global token still gets a signal
  // instead of silence. This config does NOT export on its own and never
  // did in this per-user world: `resolveExporters` (built inside
  // `buildServerOptions`) only ever reads a user's own stored connection.
  // The only thing this legacy value still does is seed that connection for
  // one user, below, via `adoptLegacyNotionIfUnambiguous` — attempted on
  // every boot, but a no-op once that user has a connection of their own.
  console.log(
    "NOTION_TOKEN/NOTION_DATABASE_ID are deprecated: connect each user's own workspace via " +
      "/app/exports, then unset these once everyone has.",
  );
}

// One-time (per install) adoption of transcripts written before the relay was
// multi-tenant. No-ops on every boot after the first, once the flat root
// holds only per-user directories. Independent of the legacy-Notion
// adoption below: that migration ships on a different branch/plan and may
// already be long done (or may never run at all, on an install that started
// multi-tenant), so the Notion adoption below cannot depend on catching this
// one still pending.
const migrated = migrateFlatTranscripts(config.transcriptsDir, identity);
if (migrated) {
  // This is a live bearer token, printed exactly once because there is no
  // other way to hand the operator a credential for a user the relay just
  // minted on their behalf. Whatever aggregates these logs (`fly logs`, a
  // log drain, etc.) now holds it too — treat that output with the same
  // care as any other secret. There is no revoke/rotate for it beyond
  // pairing a new device onto this user and no longer using the old one.
  console.log(
    `Migrated ${migrated.moved} file(s) to user ${migrated.userId}. ` +
      `Adopt existing installs with this token (shown once): ${migrated.token}`,
  );
}

// The legacy single-workspace NOTION_TOKEN has no reliable owner once the
// relay is multi-tenant — it only maps unambiguously onto a user when there
// is exactly one. Safe to re-run every boot: the adoption resolves a user
// (adopted, or found already connected) at most once ever, via a marker that
// survives that user later disconnecting — so this can never silently undo a
// deliberate Disconnect. See its doc comment in exportDestinations.ts for the
// rest of the reasoning, including why it is deliberately independent of the
// flat-transcript migration above.
//
// `adoptLegacyNotionAtBoot`, not `adoptLegacyNotionIfUnambiguous`: this is
// module scope, so an exception here is not a failed adoption but a relay
// that never listens, on a Fly restart loop, with captioning down for an
// export-only reason (a rotated ENCRYPTION_KEY, a database restored from
// another environment). The wrapper logs and returns `failed` instead.
const legacyNotion = adoptLegacyNotionAtBoot(identity, options.destinations, config.notion);
if (legacyNotion.outcome === "adopted") {
  console.log(`Adopted the legacy Notion connection onto the relay's one user (${legacyNotion.userId}).`);
} else if (legacyNotion.outcome === "already-resolved") {
  // Fires on every boot after the first, once resolved — that repetition is
  // deliberate: it is the only place an operator can currently confirm it is
  // safe to unset NOTION_TOKEN/NOTION_DATABASE_ID (nothing here is reading
  // them for this user anymore, resolved or not still connected).
  console.log(
    `Legacy Notion config already resolved for the relay's one user (${legacyNotion.userId}); ` +
      "NOTION_TOKEN/NOTION_DATABASE_ID can be unset.",
  );
} else if (legacyNotion.outcome === "ambiguous") {
  console.log(
    "NOTION_TOKEN/NOTION_DATABASE_ID could not be adopted onto a single user automatically " +
      "(this relay has zero or more than one registered user) — connect each user's own " +
      "workspace via /app/exports instead.",
  );
}

const server = startServer(options);

const addr = server.address();
const port = typeof addr === "object" && addr ? addr.port : config.port;
console.log(`Caption relay listening on ws://0.0.0.0:${port}/stream`);
console.log(`Transcripts in ${config.transcriptsDir}; viewer at /app, export destinations at /app/exports`);

/**
 * Catch up on stored transcripts: summarize any that never got one (the key
 * was unset, out of credit, or erroring at the time), then export anything
 * that never reached Notion. Summaries run first so a transcript exported in
 * the same sweep carries its summary.
 *
 * Runs once per user directory and sums the results, rather than once over
 * the flat root: transcripts live under `userDir(root, userId)` now, so a
 * single sweep of the root itself would see no `.jsonl` files and do
 * nothing. Each directory's owner resolves their own Notion connection (or
 * none), rather than this sweep being gated on one operator-wide setting.
 */
async function runBackfills(): Promise<void> {
  const dirs = userDirs(config.transcriptsDir);
  // Same resolver the live finalizer uses (built from `options.destinations`
  // inside `buildServerOptions`) — reconstructed here via the same pure
  // helper rather than a second copy of the resolution logic.
  const resolveExporters = buildResolveExporters(options.destinations);

  if (summarize) {
    const totals = { summarized: 0, patched: 0, failed: 0 };
    for (const { dir, userId } of dirs) {
      const r = await backfillSummaries({
        dir,
        userId,
        summarize,
        resolve: resolveExporters,
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
  const notionTotals = { exported: 0, failed: 0 };
  for (const { dir, userId } of dirs) {
    const r = await backfillNotion({ dir, userId, resolve: resolveExporters });
    notionTotals.exported += r.exported;
    notionTotals.failed += r.failed;
  }
  if (notionTotals.exported || notionTotals.failed) {
    console.log(`Notion backfill: ${notionTotals.exported} exported, ${notionTotals.failed} failed`);
  }
}

void runBackfills().catch((err) => console.error("backfill failed:", err));
