
export interface Config {
  port: number;
  authToken: string;
  deepgramApiKey: string;
  /** Where session transcripts are persisted (a Fly volume in prod). */
  transcriptsDir: string;
  /** Optional; when set, transcripts are summarized with Claude on session end. */
  anthropicApiKey?: string;
  /** Optional; enables the `openai` caption provider. */
  openaiApiKey?: string;
  /** Optional; enables the `assemblyai` caption provider. */
  assemblyaiApiKey?: string;
  /** Optional; when set, finished transcripts are exported to Notion. */
  notion?: NotionConfig;
}

export interface NotionConfig {
  /** Internal integration token (`ntn_…`). */
  token: string;
  /** Target database id; it must be shared with the integration. */
  databaseId: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const authToken = env.AUTH_TOKEN;
  if (!authToken) throw new Error("AUTH_TOKEN is required");
  const deepgramApiKey = env.DEEPGRAM_API_KEY;
  if (!deepgramApiKey) throw new Error("DEEPGRAM_API_KEY is required");
  const port = env.PORT ? Number(env.PORT) : 8080;
  const transcriptsDir = env.TRANSCRIPTS_DIR || "./data/transcripts";

  return {
    port,
    authToken,
    deepgramApiKey,
    transcriptsDir,
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    openaiApiKey: env.OPENAI_API_KEY || undefined,
    assemblyaiApiKey: env.ASSEMBLYAI_API_KEY || undefined,
    notion: loadNotion(env),
  };
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
