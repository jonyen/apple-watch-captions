import { join } from "path";
import { NotionOAuthConfig } from "./notionOAuth";
import { PROVIDER_NAMES, ProviderName } from "./providerOptions";
import { APPLE_DEFAULT_URL } from "./appleProvider";

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
  /**
   * Optional; deprecated. Once exported every finished transcript to one
   * relay-wide Notion database; exports nothing on its own now — every
   * export reads a user's own stored connection, with no fallback to this.
   * The only thing it still does is get folded onto the relay's one user's
   * destination row, when there is exactly one (see
   * `adoptLegacyNotionIfUnambiguous`, called from `index.ts` on every boot).
   * Superseded by `notionOAuth`, which lets each user connect their own
   * workspace.
   */
  notion?: NotionConfig;
  /**
   * Optional; seals/opens the secrets in `export_destinations`. Unset means
   * per-user export destinations are disabled — captioning itself must not
   * depend on this being configured.
   */
  encryptionKey?: string;
  /** Deepgram model for phone audio. Overridable — the right one is an open question. */
  deepgramPhoneModel: string;
  /** Optional; the number Twilio bridges an inbound captioned call to. */
  twilioForwardTo?: string;
  /**
   * Trust `Fly-Client-IP` as the caller's address when rate-limiting
   * registrations, instead of the raw socket address. Must only be on when
   * the relay genuinely sits behind a proxy that overwrites that header —
   * see `clientAddress` in `server.ts`.
   */
  trustProxyHeaders: boolean;
  /** Optional; enables per-user Notion export via /v1/exports/notion/*. All three parts are required. */
  notionOAuth?: NotionOAuthConfig;
  /** Public origin the OAuth redirect returns to, e.g. https://relay.fly.dev. Required alongside notionOAuth. */
  publicBaseUrl?: string;
  /** Optional; Resend API key. Required alongside emailFrom to enable /v1/exports/email. */
  resendApiKey?: string;
  /** Optional; the From address transcript and verification emails are sent from. */
  emailFrom?: string;
  /**
   * Optional; the relay-wide default transcription backend when a session
   * doesn't request one explicitly (`ProviderOptions.provider` always wins).
   * Unset means the existing default, deepgram.
   */
  transcriptionProvider?: ProviderName;
  /** Base URL of the local caption-transcriber sidecar (Task 3's Apple provider). */
  appleTranscriberUrl: string;
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
  const publicBaseUrl = env.PUBLIC_BASE_URL || undefined;
  warnIfPublicBaseUrlIsNotThisApp(env, publicBaseUrl);

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
    encryptionKey: env.ENCRYPTION_KEY || undefined,
    // "phonecall" is the safe baseline: @deepgram/sdk@3.13.0 only exposes
    // listen.live() against the v1 `:version/listen` endpoint, and Flux
    // models are served by a separate v2 streaming API this relay does not
    // use. Defaulting to a Flux model would fail the first real call.
    deepgramPhoneModel: env.DEEPGRAM_PHONE_MODEL || "phonecall",
    twilioForwardTo: env.TWILIO_FORWARD_TO || undefined,
    trustProxyHeaders: loadTrustProxyHeaders(env),
    notionOAuth: loadNotionOAuth(env, publicBaseUrl),
    publicBaseUrl,
    resendApiKey: env.RESEND_API_KEY || undefined,
    emailFrom: env.EMAIL_FROM || undefined,
    transcriptionProvider: loadTranscriptionProvider(env),
    appleTranscriberUrl: env.APPLE_TRANSCRIBER_URL || APPLE_DEFAULT_URL,
  };
}

/** Only the backends we actually implement; anything else is a typo. */
function loadTranscriptionProvider(env: NodeJS.ProcessEnv): ProviderName | undefined {
  const value = env.TRANSCRIPTION_PROVIDER;
  if (!value) return undefined;
  if ((PROVIDER_NAMES as readonly string[]).includes(value)) return value as ProviderName;
  console.warn(
    `Ignoring TRANSCRIPTION_PROVIDER="${value}" — expected one of ${PROVIDER_NAMES.join(", ")}`,
  );
  return undefined;
}

/**
 * Shout if `PUBLIC_BASE_URL` points somewhere other than this app.
 *
 * It is a shipped default in `fly.toml` (this project's own `fly.dev`
 * hostname), and `fly.dev` names are globally unique — so an operator
 * deploying from scratch *must* rename the app, and the default then names a
 * host they do not control. Two live credentials are built from this value:
 * the Notion OAuth `redirect_uri`, which is where Notion sends the user's
 * browser carrying a real authorization code, and the emailed confirmation
 * link, which carries a real verification token to the user's inbox
 * alongside their address. Both would be delivered to the wrong host.
 *
 * A warning rather than a throw: on Fly a custom domain is a perfectly
 * legitimate mismatch, and refusing to boot over it would take captioning
 * down for an export setting. Off Fly (`FLY_APP_NAME` unset) there is nothing
 * to compare against, so this says nothing at all.
 */
function warnIfPublicBaseUrlIsNotThisApp(
  env: NodeJS.ProcessEnv,
  publicBaseUrl: string | undefined,
): void {
  const app = env.FLY_APP_NAME;
  if (!app || !publicBaseUrl) return;
  let host: string;
  try {
    host = new URL(publicBaseUrl).host;
  } catch {
    console.warn(
      `PUBLIC_BASE_URL="${publicBaseUrl}" is not a valid URL — the Notion redirect URI and the ` +
        "emailed confirmation link are built from it and will be malformed.",
    );
    return;
  }
  const own = `${app}.fly.dev`;
  if (host === own) return;
  console.warn(
    `PUBLIC_BASE_URL is "${publicBaseUrl}" but this app is "${app}", whose own hostname is ` +
      `"${own}". Notion authorization codes and emailed verification tokens will be sent to ` +
      `"${host}", not to this relay. Ignore this only if "${host}" is a custom domain routed ` +
      `here; otherwise set PUBLIC_BASE_URL to "https://${own}" in fly.toml.`,
  );
}

/**
 * Whether to believe `Fly-Client-IP`.
 *
 * Defaults to **off**, which is the safe answer when the relay is exposed
 * directly: a forgeable address header would let one caller pick a fresh key
 * per request and evade the registration limiter entirely. Behind Fly's
 * `http_service` it must be on instead — there, every request arrives from
 * the proxy's address, so leaving it off collapses every caller in the world
 * into a single 10-per-hour bucket and ten requests from anyone would refuse
 * registration (the only way to get a credential) to everyone.
 *
 * An unrecognized value falls back to off and warns rather than being coerced
 * silently: this is the kind of flag whose typo is only ever discovered in
 * production, in one of the two failure modes above.
 */
function loadTrustProxyHeaders(env: NodeJS.ProcessEnv): boolean {
  const value = env.TRUST_PROXY_HEADERS;
  if (!value) return false;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  console.warn(`Ignoring TRUST_PROXY_HEADERS="${value}" — expected "true" or "false"`);
  return false;
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
 * The relay's registered Notion OAuth integration, letting each user connect
 * their own workspace. Unset means that flow stays off — captioning itself
 * must not depend on it — while the legacy single-workspace `notion` config
 * above continues to work independently until every user has migrated.
 */
function loadNotionOAuth(
  env: NodeJS.ProcessEnv,
  baseUrl: string | undefined,
): NotionOAuthConfig | undefined {
  const clientId = env.NOTION_CLIENT_ID;
  const clientSecret = env.NOTION_CLIENT_SECRET;
  if (!clientId || !clientSecret) return undefined;
  if (!baseUrl) {
    console.warn("Notion OAuth disabled: PUBLIC_BASE_URL is required for the redirect URI");
    return undefined;
  }
  return {
    clientId,
    clientSecret,
    redirectUri: `${baseUrl.replace(/\/$/, "")}/v1/exports/notion/callback`,
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
