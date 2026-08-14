import { join } from "path";

export interface Config {
  port: number;
  deepgramApiKey: string;
  /** Where session transcripts are persisted (a Fly volume in prod). */
  transcriptsDir: string;
  /** Operator-only token for /v1/usage. */
  adminToken?: string;
  /** Where the identity database lives (beside the transcripts, on the volume). */
  dbPath: string;
  /** Optional; when set, transcripts are summarized with Claude on session end. */
  anthropicApiKey?: string;
  /** Optional; the free-tier alternative to Claude for summaries. */
  geminiApiKey?: string;
  /** Which backend summarizes; defaults to whichever key is set. */
  summaryProvider?: SummaryProvider;
  /** Optional; enables the `openai` caption provider. */
  openaiApiKey?: string;
  /** Optional; enables the `assemblyai` caption provider. */
  assemblyaiApiKey?: string;
  /** Optional; when set, finished transcripts are exported to Notion. */
  notion?: NotionConfig;
  /** Deepgram model for phone audio. Overridable — the right one is an open question. */
  deepgramPhoneModel: string;
  /** Optional; the number Twilio bridges an inbound captioned call to. */
  twilioForwardTo?: string;
}

export type SummaryProvider = "claude" | "gemini";

export interface NotionConfig {
  /** Internal integration token (`ntn_…`). */
  token: string;
  /** Target database id; it must be shared with the integration. */
  databaseId: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const deepgramApiKey = env.DEEPGRAM_API_KEY;
  if (!deepgramApiKey) throw new Error("DEEPGRAM_API_KEY is required");
  const port = env.PORT ? Number(env.PORT) : 8080;
  const transcriptsDir = env.TRANSCRIPTS_DIR || "./data/transcripts";

  return {
    port,
    deepgramApiKey,
    transcriptsDir,
    adminToken: env.ADMIN_TOKEN || undefined,
    dbPath: env.DB_PATH || join(transcriptsDir, "identity.db"),
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    geminiApiKey: env.GEMINI_API_KEY || undefined,
    summaryProvider: loadSummaryProvider(env),
    openaiApiKey: env.OPENAI_API_KEY || undefined,
    assemblyaiApiKey: env.ASSEMBLYAI_API_KEY || undefined,
    notion: loadNotion(env),
    // "phonecall" is the safe baseline: @deepgram/sdk@3.13.0 only exposes
    // listen.live() against the v1 `:version/listen` endpoint, and Flux
    // models are served by a separate v2 streaming API this relay does not
    // use. Defaulting to a Flux model would fail the first real call.
    deepgramPhoneModel: env.DEEPGRAM_PHONE_MODEL || "phonecall",
    twilioForwardTo: env.TWILIO_FORWARD_TO || undefined,
  };
}

/** Only the backends we actually implement; anything else is a typo. */
function loadSummaryProvider(env: NodeJS.ProcessEnv): SummaryProvider | undefined {
  const value = env.SUMMARY_PROVIDER;
  if (!value) return undefined;
  if (value === "claude" || value === "gemini") return value;
  console.warn(`Ignoring SUMMARY_PROVIDER="${value}" — expected "claude" or "gemini"`);
  return undefined;
}

/**
 * Notion needs both halves to work. A half-configured integration is a
 * misconfiguration, but not one worth refusing to serve captions over —
 * warn and leave the export disabled.
 */
function loadNotion(env: NodeJS.ProcessEnv): NotionConfig | undefined {
  const token = env.NOTION_TOKEN || undefined;
  const databaseId = env.NOTION_DATABASE_ID || undefined;
  if (token && databaseId) return { token, databaseId };
  if (token || databaseId) {
    console.warn("Notion export disabled: set both NOTION_TOKEN and NOTION_DATABASE_ID");
  }
  return undefined;
}
