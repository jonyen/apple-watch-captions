
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
  /** Optional; with notionDatabaseId, syncs finished transcripts to Notion. */
  notionApiKey?: string;
  /** Optional; the Notion database transcript pages are created in. */
  notionDatabaseId?: string;
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
    notionApiKey: env.NOTION_API_KEY || undefined,
    notionDatabaseId: env.NOTION_DATABASE_ID || undefined,
  };
}
