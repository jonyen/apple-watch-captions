import { Config } from "./config";
import { Db } from "./db";
import { IdentityStore } from "./identityStore";
import { TranscriptionProvider } from "./transcriptionProvider";
import { ProviderOptions } from "./providerOptions";
import { TranscriptStore } from "./transcriptStore";
import { Summarize } from "./summarizer";
import { createFinalizer, ResolveExporters } from "./finalizer";
import {
  createNotionExporter,
  createNotionSummaryPatcher,
  NotionApiError,
  NotionExporterOptions,
} from "./notionExporter";
import { createNotionUpdater } from "./notionUpdater";
import { ExportDestinationStore } from "./exportDestinations";
import { keyFromEnv } from "./secretBox";
import { createResendSender, createTranscriptEmailSender } from "./emailSender";
import { OAuthStateStore, createCodeExchange, createDatabaseFinder } from "./notionOAuth";
import { EmailVerificationStore } from "./emailVerification";
import type { StartServerOptions } from "./server";
import type { ReportData } from "./usageReport";

export interface ServerDeps {
  db: Db;
  identity: IdentityStore;
  createProvider: (opts?: ProviderOptions) => TranscriptionProvider;
  summarize?: Summarize;
  usage?: { getUsage(): Promise<ReportData> };
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Build that user's Notion clients from their stored credentials. Constructed
 * per call rather than cached: a user can disconnect or reconnect at any
 * time, and a cached client would keep exporting to a workspace they
 * revoked. Exported on its own — not folded into `buildServerOptions` —
 * because the boot backfill sweep in `index.ts` needs the same resolver the
 * live finalizer uses, not a second copy of this logic.
 */
/**
 * Note a 401 against this user's connection, then let the error continue.
 *
 * Wrapping here rather than at each call site means the finalizer, the boot
 * backfill, and the summary patcher all inherit the behaviour from one place —
 * three separate catch blocks would be three chances to drift. Only 401 counts:
 * a 500 or a timeout is Notion having a bad day, and disabling someone's export
 * over one would be worse than the retry it saves.
 */
function revokeOn401<A extends unknown[], R>(
  destinations: ExportDestinationStore,
  userId: string,
  failedToken: string,
  call: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args) => {
    try {
      return await call(...args);
    } catch (err) {
      if (err instanceof NotionApiError && err.status === 401) {
        // Scoped to the token this client was built with. A sweep can run for
        // minutes, and the badge asks the user to reconnect meanwhile — an
        // unscoped revoke would kill the fresh connection they just made.
        destinations.markNotionRevoked(userId, failedToken);
      }
      throw err;
    }
  };
}

export interface ResolveExportersDeps {
  /** Injectable for tests; passed through to the Notion clients. */
  fetchImpl?: NotionExporterOptions["fetch"];
}

export function buildResolveExporters(
  destinations?: ExportDestinationStore,
  deps: ResolveExportersDeps = {},
): ResolveExporters {
  return (userId) => {
    // Returns null for a revoked connection too, so a dead token is never
    // handed out again — the export simply does not happen until reconnect.
    const connection = destinations?.getNotion(userId);
    if (!connection || !destinations) return undefined;
    const opts = {
      token: connection.token,
      databaseId: connection.config.databaseId,
      ...(deps.fetchImpl ? { fetch: deps.fetchImpl } : {}),
    };
    const revoking = <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
      revokeOn401(destinations, userId, connection.token, call);
    return {
      export: revoking(createNotionExporter(opts)),
      update: revoking(createNotionUpdater(opts)),
      patchSummary: revoking(createNotionSummaryPatcher(opts)),
    };
  };
}

/**
 * Assemble the options `startServer` runs with, from config and the handful
 * of already-constructed dependencies (the database, identity store, and
 * caption provider factory) that can't be built from config alone.
 *
 * Deliberately pure aside from constructing the stateful clients themselves
 * (stores, senders): no console output and no boot-time side effects like
 * directory creation or migrations, so it is safe to call from a test with a
 * fake config and an in-memory database and assert on the object it returns.
 * That is the point of splitting this out of `index.ts` at all —
 * `deployWiring.test.ts` can only check that index.ts's source text
 * *mentions* an option, never that the option ends up correctly gated; an
 * inverted condition or a value pinned to `undefined` reads identically to
 * the textual check. See `serverOptions.test.ts`, which caught exactly that
 * class of bug in fix round 1.
 *
 * Every optional piece is gated on what actually makes it usable, not on its
 * own setting in isolation. The Notion OAuth pieces in particular gate on
 * `destinations` as well as `notionOAuth`: without `destinations` there is
 * nowhere to store a granted token, and starting the flow anyway would send
 * a user to Notion's real consent screen — where they grant a real
 * workspace scope — only to bounce back to a dead end with no way to fix it.
 * Gating here means the `/start` route's existing `!opts.oauthStates` check
 * 503s before the user ever reaches Notion, the same way the email path
 * already fails closed at 503 before any user action.
 */
export function buildServerOptions(config: Config, deps: ServerDeps): StartServerOptions {
  const destinations = config.encryptionKey
    ? new ExportDestinationStore(deps.db, keyFromEnv(config.encryptionKey))
    : undefined;

  const sendEmail =
    config.resendApiKey && config.emailFrom
      ? createResendSender(config.resendApiKey, config.emailFrom, deps.fetchImpl)
      : undefined;

  const notionOAuthReady = Boolean(config.notionOAuth) && Boolean(destinations);
  const oauthStates = notionOAuthReady ? new OAuthStateStore(deps.db) : undefined;
  const exchangeNotionCode = notionOAuthReady
    ? createCodeExchange(config.notionOAuth!, deps.fetchImpl)
    : undefined;
  const findNotionDatabase = notionOAuthReady ? createDatabaseFinder(deps.fetchImpl) : undefined;

  const emailVerifications =
    sendEmail && config.publicBaseUrl ? new EmailVerificationStore(deps.db) : undefined;

  const resolveExporters = buildResolveExporters(destinations);

  const transcripts = new TranscriptStore({
    root: config.transcriptsDir,
    onFinalize: createFinalizer({
      root: config.transcriptsDir,
      summarize: deps.summarize,
      resolve: resolveExporters,
      // Only sends to an address the user has actually verified —
      // `createTranscriptEmailSender` is the single choke point that
      // enforces that, so it's reused here rather than duplicated inline.
      sendTranscriptEmail:
        destinations && sendEmail
          ? createTranscriptEmailSender(destinations, sendEmail)
          : undefined,
    }),
  });

  return {
    port: config.port,
    identity: deps.identity,
    adminToken: config.adminToken,
    createProvider: deps.createProvider,
    transcripts,
    transcriptsRoot: config.transcriptsDir,
    usage: deps.usage,
    callForwardTo: config.twilioForwardTo,
    trustProxyHeaders: config.trustProxyHeaders,
    destinations,
    oauthStates,
    notionOAuth: config.notionOAuth,
    exchangeNotionCode,
    findNotionDatabase,
    emailVerifications,
    sendEmail,
    publicBaseUrl: config.publicBaseUrl,
  };
}
