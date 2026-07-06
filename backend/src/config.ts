
export interface Config {
  port: number;
  authToken: string;
  deepgramApiKey: string;
  /** Where session transcripts are persisted (a Fly volume in prod). */
  transcriptsDir: string;
  /** Optional; when set, transcripts are summarized with Claude on session end. */
  anthropicApiKey?: string;
  /** Optional; when set, a "transcript ready" email is sent on session end. */
  mail?: {
    user: string;
    pass: string;
    to: string;
    appUrl?: string;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const authToken = env.AUTH_TOKEN;
  if (!authToken) throw new Error("AUTH_TOKEN is required");
  const deepgramApiKey = env.DEEPGRAM_API_KEY;
  if (!deepgramApiKey) throw new Error("DEEPGRAM_API_KEY is required");
  const port = env.PORT ? Number(env.PORT) : 8080;
  const transcriptsDir = env.TRANSCRIPTS_DIR || "./data/transcripts";

  // Email notification is enabled only when all three mail settings are present.
  // The viewer link falls back to the Fly app hostname (FLY_APP_NAME is set
  // automatically on Fly machines).
  let mail: Config["mail"];
  if (env.MAIL_USERNAME && env.MAIL_PASSWORD && env.NOTIFY_EMAIL_TO) {
    const appUrl =
      env.PUBLIC_URL || (env.FLY_APP_NAME ? `https://${env.FLY_APP_NAME}.fly.dev` : undefined);
    mail = {
      user: env.MAIL_USERNAME,
      pass: env.MAIL_PASSWORD,
      to: env.NOTIFY_EMAIL_TO,
      appUrl,
    };
  }

  return {
    port,
    authToken,
    deepgramApiKey,
    transcriptsDir,
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    mail,
  };
}
