import { WebSocketServer, WebSocket } from "ws";
import { createServer, Server, IncomingMessage, ServerResponse } from "http";
import { mkdirSync, readdirSync, renameSync, existsSync, rmdirSync } from "fs";
import { join } from "path";
import { AddressInfo } from "net";
import { randomUUID, timingSafeEqual } from "crypto";
import { bearerToken, resolveToken } from "./auth";
import { IdentityStore, DeviceKind, Principal } from "./identityStore";
import { CaptionSession, OutboundMessage } from "./captionSession";
import { TranscriptionProvider } from "./transcriptionProvider";
import { SessionStore } from "./sessionStore";
import { CurrentCall } from "./currentCall";
import { ReaderPresence } from "./readerPresence";
import { handleTwilioStream, TwilioSocketLike } from "./twilioStreamHandler";
import {
  TranscriptStore,
  listTranscripts,
  readTranscript,
  readExportStatus,
  deleteTranscript,
  userDir,
  TRANSCRIPT_SUFFIXES,
} from "./transcriptStore";
import { VIEWER_HTML } from "./viewerPage";
import { EXPORTS_HTML } from "./exportsPage";
import type { ReportData } from "./usageReport";
import { PROVIDER_NAMES, ProviderOptions } from "./providerOptions";
import { voiceResponse } from "./twiml";
import { ExportDestinationStore } from "./exportDestinations";
import { OAuthStateStore, authorizeUrl, NotionOAuthConfig, ExchangeCode } from "./notionOAuth";
import { EmailVerificationStore } from "./emailVerification";
import { SendEmail } from "./emailSender";

export * from "./providerOptions";

export interface StartServerOptions {
  port: number;
  /** Users, devices, and pairing codes. Every authenticated route resolves its principal through this. */
  identity: IdentityStore;
  /**
   * Operator-only token for `/v1/usage`. It reports the operator's Deepgram
   * and Fly bill, not a per-user figure, so a device token must never reach
   * it — and with no admin token configured the endpoint stays closed.
   */
  adminToken?: string;
  /**
   * Trust the `Fly-Client-IP` header for the registration rate limiter's
   * address key, instead of the raw socket address. `X-Forwarded-For` is
   * never consulted, flag on or off — see `clientAddress`. Off by default.
   * Only turn this on when the relay genuinely sits behind a proxy that
   * overwrites `Fly-Client-IP` on the way in (as Fly's `http_service` does)
   * — otherwise a caller could forge the header and evade the limit
   * entirely.
   */
  trustProxyHeaders?: boolean;
  /** Factory for a fresh provider per connection/session (Deepgram in prod, fake in tests). */
  createProvider: (opts?: ProviderOptions) => TranscriptionProvider;
  /** Optional transcript persistence; also enables the /v1/transcripts endpoints. */
  transcripts?: TranscriptStore;
  /** Root directory the transcript endpoints read from, one subdirectory per user (required with `transcripts`). */
  transcriptsRoot?: string;
  /** Optional usage data source; enables GET /v1/usage. */
  usage?: { getUsage(): Promise<ReportData> };
  /** Optional; the number an inbound captioned call is bridged to. Enables /twilio/voice. */
  callForwardTo?: string;
  /** Optional; where each user's export destinations live. Enables /v1/exports*. */
  destinations?: ExportDestinationStore;
  /** Optional; single-use CSRF state for the Notion OAuth flow. Required alongside `notionOAuth` to enable connecting. */
  oauthStates?: OAuthStateStore;
  /** Optional; this relay's registered Notion OAuth integration. */
  notionOAuth?: NotionOAuthConfig;
  /** Trade a Notion authorization code for an access token. Injectable for tests. */
  exchangeNotionCode?: ExchangeCode;
  /**
   * Find a database to export into, using the token just granted.
   *
   * Notion only returns a database id directly from the token exchange for
   * template-based integrations (`duplicated_template_id`). A normal
   * integration grants access to pages the user picks on the consent screen
   * and the token response carries no database id at all, so the callback
   * falls back to this search when `exchangeNotionCode` supplies none.
   * Injectable for tests — production wiring calls Notion's `/v1/search`.
   */
  findNotionDatabase?: (accessToken: string) => Promise<{ id: string; title?: string } | null>;
  /** Optional; single-use, expiring proof of control over an email address. Required alongside `sendEmail`, `destinations`, and `publicBaseUrl` to enable /v1/exports/email. */
  emailVerifications?: EmailVerificationStore;
  /** Optional; sends the verification email. Injectable for tests. */
  sendEmail?: SendEmail;
  /** Public origin the confirmation link points back to, e.g. https://relay.fly.dev. Required alongside the email options above. */
  publicBaseUrl?: string;
}

export interface CaptionServer {
  address(): AddressInfo | string | null;
  close(): Promise<void>;
}

/** Cap on a single audio POST body (~512 KB ≈ 16 s of 16 kHz mono Int16). */
const MAX_AUDIO_BYTES = 512 * 1024;
const REAP_INTERVAL_MS = 5_000;
/** A registration body is `{"kind":"watch"}`; anything larger is not one. */
const MAX_REGISTRATION_BYTES = 1024;
const DEVICE_KINDS: DeviceKind[] = ["watch", "phone", "mac"];
/** Registrations allowed per address per window, and the window itself. */
const REGISTRATIONS_PER_WINDOW = 10;
const REGISTRATION_WINDOW_MS = 60 * 60_000;
/**
 * Failed `/v1/pair/claim` attempts allowed per claiming device before it is
 * refused outright, and the window they're counted over.
 *
 * `/v1/devices` registers with no credential by design, so an attacker can
 * mint a device for free and brute-force a six-digit code inside its
 * 10-minute window — the code space is only 1,000,000 and a hit hands over
 * the victim's whole account. Five is ample for a human keying six digits on
 * a Digital Crown, and cuts an attacker with ten devices an hour to a
 * negligible number of guesses. Kept as its own budget and window, separate
 * from `REGISTRATIONS_PER_WINDOW`, so a burst of pairing typos can't lock a
 * device out of registering.
 */
const PAIR_CLAIM_ATTEMPTS_PER_WINDOW = 5;
const PAIR_CLAIM_WINDOW_MS = 10 * 60_000;
/**
 * Pairing codes a device may issue per window, and the window.
 *
 * Issuing looks read-only and is not: `issuePairingCode` first sweeps
 * `pairing_codes` for dead rows, on the one SQLite writer every other request
 * queues behind, and then writes a row. Left unrated, a single token could
 * drive that indefinitely — and at saturation the allocator exhausts its
 * retries and throws, which surfaces as a 500 and breaks pairing for
 * everyone.
 *
 * Ten per hour is far above the human act this serves (open the phone app,
 * read six digits off it, key them into the watch) while leaving no useful
 * room to hammer the writer. Its own budget and window, like the claim side:
 * a device that has been retyping codes must not thereby lose its ability to
 * issue one, and vice versa.
 */
const PAIR_CODE_ISSUES_PER_WINDOW = 10;
const PAIR_CODE_WINDOW_MS = 60 * 60_000;
/**
 * Verification emails a device may trigger per window, and the window.
 *
 * The relay sends mail to whatever address `/v1/exports/email` names, so an
 * unlimited caller could use it to deliver mail to strangers — this is the
 * only thing standing between that and an open remailer, alongside the
 * single-use expiring confirmation token itself.
 */
const EMAIL_SENDS_PER_WINDOW = 5;
const EMAIL_WINDOW_MS = 60 * 60_000;

/**
 * Confirmation links a client address may follow per window, and the window.
 *
 * Spec section 6 requires the confirmation endpoint to be rate limited. The
 * token is 32 random bytes, so guessing one is not a realistic attack and
 * this is a backstop rather than the defence; what it actually bounds is an
 * unauthenticated endpoint that does a database read and a write per call.
 * Keyed on the caller's address, since there is no bearer token here — the
 * request comes from whatever inbox the link was opened in. A real user
 * follows their link once, so the budget only has to leave room for a mail
 * client prefetching it and the user clicking a couple of times.
 */
const EMAIL_CONFIRMS_PER_WINDOW = 10;
const EMAIL_CONFIRM_WINDOW_MS = 60 * 60_000;

/**
 * Per-key sliding-window limiter. Used both for `/v1/devices` registrations
 * (keyed by address) and for failed `/v1/pair/claim` attempts (keyed by
 * device) — same mechanism, different key, budget, and window.
 *
 * Registration cannot require a credential — an app has none before it
 * registers — so the only backstop is a rate limit. A junk account costs one
 * table row today; this must be revisited before a free account grants any
 * metered cloud usage.
 */
export class RegistrationLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly limit: number = REGISTRATIONS_PER_WINDOW,
    private readonly windowMs: number = REGISTRATION_WINDOW_MS,
  ) {}

  allow(key: string): boolean {
    const cutoff = this.now() - this.windowMs;
    // Opportunistic eviction: a key that hits once and never returns would
    // otherwise hold its bucket forever — this process never restarts to
    // clear it (Fly runs it with auto_stop_machines off). Swept on every
    // call rather than on a timer, since both registrations and pairing
    // attempts are rare enough that this stays cheap.
    this.evictStale(cutoff);
    const recent = (this.hits.get(key) ?? []).filter((at) => at > cutoff);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(this.now());
    this.hits.set(key, recent);
    return true;
  }

  /**
   * Whether `key` currently has budget, without spending any of it. Lets a
   * caller refuse outright — before doing any real work — once a key is
   * exhausted, rather than merely relabeling the response after the fact:
   * for `/v1/pair/claim`, that distinction is what stops an exhausted device
   * from still getting a real guess against the database.
   */
  peek(key: string): boolean {
    const cutoff = this.now() - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((at) => at > cutoff);
    return recent.length < this.limit;
  }

  /** How many keys currently hold a bucket. Exposed for testing eviction. */
  size(): number {
    return this.hits.size;
  }

  private evictStale(cutoff: number): void {
    for (const [key, hits] of this.hits) {
      if (hits.every((at) => at <= cutoff)) this.hits.delete(key);
    }
  }
}

/**
 * The client address to key the registration rate limiter on.
 *
 * Fly's `http_service` proxy terminates the real TCP connection, so
 * `req.socket.remoteAddress` is the proxy's address, not the caller's.
 * `Fly-Client-IP` is trusted, when `trustProxyHeaders` is on, because Fly's
 * edge overwrites it on every request that traverses `http_service` — a
 * client cannot set it.
 *
 * `X-Forwarded-For` is deliberately NOT consulted, on or off: Fly's edge
 * *appends* its observed address to any `X-Forwarded-For` it receives rather
 * than replacing it, so a client-chosen entry (e.g. the left-most one) can
 * survive to this process untouched, letting an attacker pick a fresh
 * address per request and evade the limit entirely. A proxy with different,
 * replace-not-append semantics would need its own explicit support here —
 * this must not inherit that assumption.
 *
 * `Fly-Client-IP` is trusted verbatim, with no further parsing, on the same
 * assumption: Fly's edge *replaces* rather than appends, so only one value
 * ever reaches this process. (Node itself would join two same-named headers
 * into one comma-separated string — it only arrays `Set-Cookie` — so a
 * proxy that appended this header instead would silently poison the key.
 * That case cannot occur on this deployment; a proxy without the
 * replace guarantee would need its own handling here, not a defensive
 * parse bolted onto this one.)
 */
function clientAddress(req: IncomingMessage, trustProxyHeaders: boolean): string {
  if (trustProxyHeaders) {
    const fly = req.headers["fly-client-ip"];
    // Node never arrays this header (only Set-Cookie), so `fly` is already
    // a single string or undefined; the array check is belt-and-braces
    // against Node ever changing that, and costs nothing to keep.
    const flyValue = Array.isArray(fly) ? fly[0] : fly;
    if (flyValue?.trim()) return flyValue.trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

export function startServer(opts: StartServerOptions): CaptionServer {
  const store = new SessionStore({
    createProvider: opts.createProvider,
    transcripts: opts.transcripts,
  });
  const currentCall = new CurrentCall();
  const readers = new ReaderPresence();
  const limiter = new RegistrationLimiter();
  const claimLimiter = new RegistrationLimiter(
    undefined,
    PAIR_CLAIM_ATTEMPTS_PER_WINDOW,
    PAIR_CLAIM_WINDOW_MS,
  );
  const codeLimiter = new RegistrationLimiter(
    undefined,
    PAIR_CODE_ISSUES_PER_WINDOW,
    PAIR_CODE_WINDOW_MS,
  );
  const emailLimiter = new RegistrationLimiter(undefined, EMAIL_SENDS_PER_WINDOW, EMAIL_WINDOW_MS);
  const confirmLimiter = new RegistrationLimiter(
    undefined,
    EMAIL_CONFIRMS_PER_WINDOW,
    EMAIL_CONFIRM_WINDOW_MS,
  );
  const reaper = setInterval(() => store.reapIdle(), REAP_INTERVAL_MS);

  const http: Server = createServer((req, res) => {
    handleRequest(
      req,
      res,
      opts,
      store,
      currentCall,
      readers,
      limiter,
      claimLimiter,
      codeLimiter,
      emailLimiter,
      confirmLimiter,
    ).catch(
      () => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      },
    );
  });

  // The WebSocket endpoint is retained for testing from a real computer; the
  // watch uses the HTTP endpoints (watchOS blocks WebSockets — see TN3135).
  const wss = new WebSocketServer({ noServer: true });
  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "", "http://localhost");
    const token = url.searchParams.get("token") ?? undefined;

    // Twilio's media-stream client drops the query string: the upgrade arrives
    // as a bare `/twilio/stream`, with no `?token=`. Verified against a live
    // call — the relay saw `rawUrl=/twilio/stream gotLen=0`. So the token
    // travels in the path, which Twilio does preserve. The query form is still
    // accepted so the endpoint can be exercised directly with a normal client.
    if (url.pathname === "/twilio/stream" || url.pathname.startsWith(TWILIO_STREAM_PREFIX)) {
      const fromPath = url.pathname.startsWith(TWILIO_STREAM_PREFIX)
        ? safeDecode(url.pathname.slice(TWILIO_STREAM_PREFIX.length))
        : undefined;
      const principal = resolveToken(opts.identity, fromPath ?? token);
      if (!principal) {
        console.log("twilio upgrade rejected: token missing or wrong");
        wss.handleUpgrade(req, socket, head, (ws) => ws.close(4001, "unauthorized"));
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) =>
        handleTwilioStream(
          ws as unknown as TwilioSocketLike,
          store,
          currentCall,
          principal.userId,
        ));
      return;
    }

    if (url.pathname !== "/stream") {
      socket.destroy();
      return;
    }
    const principal = resolveToken(opts.identity, token);
    if (!principal) {
      wss.handleUpgrade(req, socket, head, (ws) => ws.close(4001, "unauthorized"));
      return;
    }
    const channels = url.searchParams.get("channels") === "2" ? 2 : undefined;
    const requested = url.searchParams.get("provider");
    const provider = PROVIDER_NAMES.find((name) => name === requested);
    if (requested && !provider) {
      wss.handleUpgrade(req, socket, head, (ws) => ws.close(4002, "unknown provider"));
      return;
    }
    const providerOpts: ProviderOptions | undefined =
      channels || provider
        ? { ...(channels ? { channels } : {}), ...(provider ? { provider } : {}) }
        : undefined;
    wss.handleUpgrade(req, socket, head, (ws) =>
      handleConnection(ws, opts, principal.userId, providerOpts));
  });

  http.listen(opts.port);

  return {
    address: () => http.address(),
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(reaper);
        store.closeAll();
        for (const client of wss.clients) client.terminate();
        wss.close(() => http.close(() => resolve()));
      }),
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: StartServerOptions,
  store: SessionStore,
  calls: CurrentCall,
  readers: ReaderPresence,
  limiter: RegistrationLimiter,
  claimLimiter: RegistrationLimiter,
  codeLimiter: RegistrationLimiter,
  emailLimiter: RegistrationLimiter,
  confirmLimiter: RegistrationLimiter,
): Promise<void> {
  const url = new URL(req.url ?? "", "http://localhost");

  // Health checks.
  if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/")) {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  // Transcript viewer web app (static page; data endpoints below need the token).
  if (req.method === "GET" && url.pathname === "/app") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(VIEWER_HTML);
    return;
  }

  // Export destinations web app — same static-page shape as /app above.
  if (req.method === "GET" && url.pathname === "/app/exports") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(EXPORTS_HTML);
    return;
  }

  // An app registers itself on first launch. Unauthenticated by necessity:
  // there is no credential to present until this call issues one.
  if (req.method === "POST" && url.pathname === "/v1/devices") {
    const identity = opts.identity;
    const address = clientAddress(req, opts.trustProxyHeaders ?? false);
    if (!limiter.allow(address)) {
      sendJSON(res, 429, { error: "too many registrations" });
      return;
    }
    let body: Buffer;
    try {
      body = await readBody(req, MAX_REGISTRATION_BYTES);
    } catch {
      sendJSON(res, 413, { error: "body too large" });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      sendJSON(res, 400, { error: "invalid json" });
      return;
    }
    const kind = (parsed as { kind?: unknown } | null)?.kind;
    if (!DEVICE_KINDS.includes(kind as DeviceKind)) {
      sendJSON(res, 400, { error: "unknown device kind" });
      return;
    }
    sendJSON(res, 200, identity.registerDevice(kind as DeviceKind));
    return;
  }

  // The phone issues a code; the watch claims it. Pairing exists because the
  // two apps register independently and would otherwise be two accounts.
  if (req.method === "POST" && url.pathname === "/v1/pair/code") {
    const principal = principalFor(req, url, opts);
    if (!principal) {
      sendJSON(res, 401, { error: "unauthorized" });
      return;
    }
    // Every issue does real work — a sweep and a write on the single SQLite
    // writer — so unlike the claim side, each attempt spends budget whether
    // or not it succeeds.
    if (!codeLimiter.allow(principal.deviceId)) {
      sendJSON(res, 429, { error: "too many pairing codes" });
      return;
    }
    sendJSON(res, 200, opts.identity.issuePairingCode(principal.userId));
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/pair/claim") {
    const principal = principalFor(req, url, opts);
    if (!principal) {
      sendJSON(res, 401, { error: "unauthorized" });
      return;
    }
    // Refused before any real work happens — including before the pairing
    // lookup — so an exhausted device cannot land a lucky guess either. A
    // check applied only to the response after the fact would still let
    // every guess reach the database; only refusing outright actually caps
    // how many guesses a brute-forcing device gets.
    if (!claimLimiter.peek(principal.deviceId)) {
      sendJSON(res, 429, { error: "too many attempts" });
      return;
    }
    let body: Buffer;
    try {
      body = await readBody(req, MAX_REGISTRATION_BYTES);
    } catch {
      sendJSON(res, 413, { error: "body too large" });
      return;
    }
    let code: unknown;
    try {
      code = (JSON.parse(body.toString("utf8")) as { code?: unknown } | null)?.code;
    } catch {
      sendJSON(res, 400, { error: "invalid json" });
      return;
    }
    if (typeof code !== "string") {
      sendJSON(res, 400, { error: "missing code" });
      return;
    }
    const result = opts.identity.claimPairingCode(code, principal);
    if (!result.ok) {
      // Only a failed guess spends budget: a device that already claimed
      // successfully must not be penalized for it on some later pairing.
      claimLimiter.allow(principal.deviceId);
      sendJSON(res, 409, { error: result.reason });
      return;
    }
    // The claim already committed in the database by this point, so a
    // filesystem problem below must never turn into a failure response —
    // that would tell the caller a pairing didn't happen when it did.
    if (result.fromUserId !== result.toUserId && opts.transcriptsRoot) {
      try {
        moveTranscripts(opts.transcriptsRoot, result.fromUserId, result.toUserId);
      } catch (err) {
        // `moveTranscripts` handles its own failures and warns about what it
        // leaves behind; anything escaping it is unexpected, and leaves the
        // same mess with none of that reporting done.
        console.error("transcript move failed during pairing:", err);
        warnStranded(opts.transcriptsRoot, result.fromUserId, result.toUserId);
      }
    }
    sendJSON(res, 200, { userId: result.toUserId });
    return;
  }

  // Twilio asks what to do with an inbound call. Answer: fork the caller's
  // audio to this relay, then bridge the call onward.
  if (req.method === "POST" && url.pathname === "/twilio/voice") {
    const principal = principalFor(req, url, opts);
    if (!principal) {
      sendJSON(res, 401, { error: "unauthorized" });
      return;
    }
    if (!opts.callForwardTo) {
      sendJSON(res, 503, { error: "call captioning not configured" });
      return;
    }
    // The host Twilio reached us on is the host it should stream back to, so
    // there is no public-URL setting to keep in sync with the deployment.
    // Token in the path, not the query — Twilio's stream client discards the
    // query string. See the upgrade handler. Re-extracted rather than kept
    // from principalFor because it is the raw token that must travel in the
    // outgoing URLs, not the principal it resolved to.
    const token = bearerToken(req.headers.authorization) ?? url.searchParams.get("token") ?? "";
    const streamUrl =
      `wss://${req.headers.host ?? ""}${TWILIO_STREAM_PREFIX}` +
      `${encodeURIComponent(token)}`;
    const streamStatusUrl =
      `https://${req.headers.host ?? ""}/twilio/stream-status` +
      `?token=${encodeURIComponent(token)}`;
    res.writeHead(200, { "content-type": "text/xml" });
    res.end(voiceResponse({ streamUrl, dialTo: opts.callForwardTo, streamStatusUrl }));
    return;
  }

  // Twilio's own account of what the media stream did. The relay cannot see a
  // stream that never connects — this is the only channel that reports one,
  // and `StreamError` carries the reason the alert log omits.
  if (req.method === "POST" && url.pathname === "/twilio/stream-status") {
    const principal = principalFor(req, url, opts);
    if (!principal) {
      sendJSON(res, 401, { error: "unauthorized" });
      return;
    }
    let body: Buffer = Buffer.from("");
    try {
      body = await readBody(req, MAX_AUDIO_BYTES);
    } catch {
      // A body we could not read is still worth acknowledging; Twilio retries
      // otherwise, and the event is diagnostic rather than load-bearing.
    }
    const fields = new URLSearchParams(body.toString("utf8"));
    const detail = ["StreamEvent", "StreamError", "StreamSid", "CallSid"]
      .map((key) => `${key}=${fields.get(key) ?? "-"}`)
      .join(" ");
    console.log(`twilio stream status: ${detail}`);
    res.writeHead(204);
    res.end();
    return;
  }

  // Presence and captions in one request: the watch uses this both to notice a
  // call is live and to read it. Read-only — unlike /v1/audio it never creates
  // a session, so polling when no call exists costs nothing upstream.
  if (req.method === "GET" && url.pathname === "/v1/call") {
    const principal = principalFor(req, url, opts);
    if (!principal) {
      sendJSON(res, 401, { error: "unauthorized" });
      return;
    }
    const since = Number(url.searchParams.get("since") ?? "0") || 0;
    // Scoped to the poller: `CurrentCall` holds one call per user, so a call
    // this poller does not own is not merely filtered out here — it is never
    // returned in the first place. That also guarantees the session lookups
    // below only ever run with the caller's own id, which is what `store.has`
    // and `store.drain` require.
    const active = calls.current(principal.userId);
    // reapIdle (or a direct /v1/stop) can drop a call's session without
    // telling CurrentCall. Left unguarded, this would report `active: true`
    // forever with no captions ever arriving — a screen that hangs rather
    // than ever saying the call ended. The call itself may still be live —
    // only its captions died — so this is `stream_lost`, not `ended`:
    // reporting "ended" here would tell the watch the call is over while you
    // may still be talking.
    if (active && !store.has(principal.userId, active.sessionId)) {
      sendJSON(res, 200, { active: false, reason: "stream_lost", events: [], seq: since });
      return;
    }
    if (!active) {
      const reason = calls.lastReason(principal.userId);
      sendJSON(res, 200, {
        active: false,
        ...(reason ? { reason } : {}),
        events: [],
        seq: since,
      });
      return;
    }
    const { events, seq } = store.drain(principal.userId, active.sessionId, since);
    sendJSON(res, 200, { active: true, events: flatten(events), seq });
    return;
  }

  // Is anything reading this session? The phone asks before it streams, so
  // audio nobody is watching never leaves the device — which is what keeps an
  // always-running capture from costing battery, data and transcription around
  // the clock. Read-only, and it never creates a session, so asking is cheap.
  // POST marks the caller present and answers in the same request; GET only
  // asks. A broadcast announces itself with `role=producer` rather than waiting
  // until audio flows, because the two sides would otherwise deadlock: the
  // phone streams only once a reader appears, and the watch opens only once a
  // producer does, so neither would ever go first.
  if (url.pathname === "/v1/presence" && (req.method === "GET" || req.method === "POST")) {
    const principal = principalFor(req, url, opts);
    if (!principal) {
      sendJSON(res, 401, { error: "unauthorized" });
      return;
    }
    const session = url.searchParams.get("session") ?? "";
    if (!session) {
      sendJSON(res, 400, { error: "missing session" });
      return;
    }
    if (req.method === "POST") {
      const role = url.searchParams.get("role");
      if (role === "producer") readers.markProducer(principal.userId, session);
      if (role === "reader") readers.mark(principal.userId, session);
    }
    sendJSON(res, 200, {
      reader: readers.isPresent(principal.userId, session),
      producer: readers.isProducing(principal.userId, session),
    });
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/v1/transcripts")) {
    if (!opts.transcriptsRoot) {
      sendJSON(res, 404, { error: "transcripts not enabled" });
      return;
    }
    const principal = principalFor(req, url, opts);
    if (!principal) {
      sendJSON(res, 401, { error: "unauthorized" });
      return;
    }
    const dir = userDir(opts.transcriptsRoot, principal.userId);
    if (url.pathname === "/v1/transcripts") {
      sendJSON(res, 200, { transcripts: listTranscripts(dir) });
      return;
    }
    const path = url.pathname.slice("/v1/transcripts/".length);

    // Has this transcript reached Notion yet? Answered on its own so a client
    // waiting on the export can poll it without pulling the whole transcript.
    if (path.endsWith("/export")) {
      const name = decodeURIComponent(path.slice(0, -"/export".length));
      const status = readExportStatus(dir, name);
      if (!status) {
        sendJSON(res, 404, { error: "not found" });
        return;
      }
      sendJSON(res, 200, status);
      return;
    }

    const name = decodeURIComponent(path);
    const detail = readTranscript(dir, name);
    if (!detail) {
      sendJSON(res, 404, { error: "not found" });
      return;
    }
    sendJSON(res, 200, detail);
    return;
  }

  // Deleting forgets the relay's copy — captions, summary, export marker. Any
  // Notion page stays: it is the archive, and the only way back.
  if (req.method === "DELETE" && url.pathname.startsWith("/v1/transcripts/")) {
    if (!opts.transcriptsRoot) {
      sendJSON(res, 404, { error: "transcripts not enabled" });
      return;
    }
    const principal = principalFor(req, url, opts);
    if (!principal) {
      sendJSON(res, 401, { error: "unauthorized" });
      return;
    }
    const name = decodeURIComponent(url.pathname.slice("/v1/transcripts/".length));
    if (!deleteTranscript(userDir(opts.transcriptsRoot, principal.userId), name)) {
      sendJSON(res, 404, { error: "not found" });
      return;
    }
    sendJSON(res, 200, { deleted: name });
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/usage") {
    if (!opts.usage) {
      sendJSON(res, 404, { error: "usage not enabled" });
      return;
    }
    // This reports the operator's Deepgram and Fly bill, not a per-user
    // figure, so a device token must not reach it.
    //
    // Header only — no `?token=` fallback, unlike every other route here. The
    // admin token is the one shared secret left in the system, and a query
    // string is written to access logs, proxy logs and browser history all
    // the way along. The fallback exists elsewhere for callers that cannot
    // set a header (Twilio's webhooks); nothing calls this one but tools that
    // can.
    const token = bearerToken(req.headers.authorization);
    if (!opts.adminToken || !token || !constantTimeEquals(token, opts.adminToken)) {
      sendJSON(res, 401, { error: "unauthorized" });
      return;
    }
    try {
      sendJSON(res, 200, await opts.usage.getUsage());
    } catch {
      sendJSON(res, 500, { error: "usage fetch failed" });
    }
    return;
  }

  if (req.method === "POST" && (url.pathname === "/v1/audio" || url.pathname === "/v1/stop")) {
    const principal = principalFor(req, url, opts);
    if (!principal) {
      sendJSON(res, 401, { error: "unauthorized" });
      return;
    }
    const session = url.searchParams.get("session") ?? "";
    if (!session) {
      sendJSON(res, 400, { error: "missing session" });
      return;
    }
    const since = Number(url.searchParams.get("since") ?? "0") || 0;

    if (url.pathname === "/v1/audio") {
      // Live sessions are never written down, so there is nothing to resume
      // into and nothing to bind. Read before the session exists, because
      // `reopen` has to happen at creation time.
      const ephemeral = url.searchParams.get("ephemeral") === "1";
      // A resumed session appends to an existing transcript instead of opening
      // a new one. Only meaningful before the session exists; later posts for
      // the same session carry the param but must not re-bind it.
      const resume = url.searchParams.get("resume");
      if (resume && !ephemeral && !store.has(principal.userId, session)) {
        opts.transcripts?.reopen(principal.userId, session, resume);
      }
      // Read at creation and only at creation: swapping engines partway
      // through a conversation would leave one transcript spoken in two
      // voices. A later post carrying a different name is ignored, the same
      // way `ephemeral` and `resume` are. An unrecognised name falls back to
      // the relay's default rather than failing the request.
      const requestedProvider = url.searchParams.get("provider");
      const provider = PROVIDER_NAMES.find((name) => name === requestedProvider);
      const providerOpts: ProviderOptions | undefined = provider ? { provider } : undefined;

      let body: Buffer;
      try {
        body = await readBody(req, MAX_AUDIO_BYTES);
      } catch {
        sendJSON(res, 413, { error: "body too large" });
        return;
      }
      // A reader is watching this session rather than producing it. Marked
      // here, on the request it was already making, so reading costs no extra
      // round trip — and so presence expires by itself when the reading stops,
      // which is the only signal available when no connection stays open.
      if (url.searchParams.get("role") === "reader") readers.mark(principal.userId, session);

      // Audio arriving is what "the phone is broadcasting" means. The watch
      // asks about this to open straight into captions on launch.
      if (body.length > 0) readers.markProducer(principal.userId, session);

      store.feed(principal.userId, session, body, ephemeral, providerOpts);
      const { events, seq } = store.drain(principal.userId, session, since);
      sendJSON(res, 200, {
        events: flatten(events),
        seq,
        // Names the transcript this session is writing to, so the client can
        // resume it later. Absent until the first caption creates the file —
        // and always absent for a live session, which creates none. Asking the
        // store rather than the query string keeps the answer stable for the
        // whole session, even if a later post drops the flag.
        transcript: store.isEphemeral(principal.userId, session)
          ? undefined
          : opts.transcripts?.activeName(principal.userId, session),
      });
      return;
    }

    // /v1/stop — drain any remaining events, then tear the session down.
    const { events, seq } = store.drain(principal.userId, session, since);
    store.stop(principal.userId, session);
    sendJSON(res, 200, { events: flatten(events), seq });
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/exports") {
    const principal = principalFor(req, url, opts);
    if (!principal) {
      sendJSON(res, 401, { error: "unauthorized" });
      return;
    }
    sendJSON(res, 200, { destinations: opts.destinations?.list(principal.userId) ?? [] });
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/exports/notion/start") {
    const principal = principalFor(req, url, opts);
    if (!principal) {
      sendJSON(res, 401, { error: "unauthorized" });
      return;
    }
    if (!opts.notionOAuth || !opts.oauthStates) {
      sendJSON(res, 503, { error: "notion export not configured" });
      return;
    }
    const state = opts.oauthStates.mint(principal.userId);
    res.writeHead(302, { location: authorizeUrl(opts.notionOAuth, state) });
    res.end();
    return;
  }

  // Notion redirects the browser here, so there is no bearer token to check.
  // The single-use `state` is what identifies the user and what stops an
  // attacker binding their own workspace to someone else's account.
  if (req.method === "GET" && url.pathname === "/v1/exports/notion/callback") {
    const fail = (reason: string = "failed") => {
      res.writeHead(302, { location: `/app/exports?notion=${reason}` });
      res.end();
    };
    const state = url.searchParams.get("state");
    if (!state || !opts.oauthStates || !opts.destinations || !opts.exchangeNotionCode) {
      fail();
      return;
    }
    const userId = opts.oauthStates.consume(state);
    if (!userId) {
      fail();
      return;
    }
    // Notion sends `error=access_denied` (and no `code`) when the user
    // clicks Cancel on the consent screen. That is routine — users will hit
    // it often — and deserves its own reason distinct from a real failure,
    // rather than collapsing into the generic "something went wrong".
    const error = url.searchParams.get("error");
    if (error) {
      fail(error === "access_denied" ? "denied" : "failed");
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      fail();
      return;
    }
    // Catches everything, not just thrown `Error`s: `createCodeExchange`
    // leaves network failures and malformed JSON unwrapped, and a fake used
    // in tests may throw any value at all.
    try {
      const granted = await opts.exchangeNotionCode(code);
      let databaseId = granted.databaseId;
      let workspaceName = granted.workspaceName;
      if (!databaseId) {
        // Normal (non-template) integrations never carry a database id in
        // the token response — search for one with the freshly granted
        // token instead. No database shared with the integration means no
        // export destination, which is worse than no connection at all, so
        // nothing is stored and the user is told why.
        if (!opts.findNotionDatabase) {
          // Distinct from "the search ran and found nothing": this is a
          // deployment gap (Task 8 wired exchangeNotionCode but not this
          // seam), not something the user can fix by sharing a database, so
          // it must not read as the same actionable "nodatabase" message.
          console.warn(
            "notion callback: findNotionDatabase is not configured; cannot resolve a database",
          );
          fail();
          return;
        }
        const found = await opts.findNotionDatabase(granted.accessToken);
        if (!found) {
          fail("nodatabase");
          return;
        }
        databaseId = found.id;
        workspaceName = workspaceName ?? found.title;
      }
      opts.destinations.putNotion(userId, granted.accessToken, {
        databaseId,
        ...(workspaceName ? { workspaceName } : {}),
      });
    } catch (err) {
      console.error("notion callback failed:", err instanceof Error ? err.message : String(err));
      fail();
      return;
    }
    res.writeHead(302, { location: "/app/exports?notion=connected" });
    res.end();
    return;
  }

  if (req.method === "DELETE" && url.pathname === "/v1/exports/notion") {
    const principal = principalFor(req, url, opts);
    if (!principal) {
      sendJSON(res, 401, { error: "unauthorized" });
      return;
    }
    // 503 rather than `{removed:false}`, like every sibling route: with no
    // store there is nothing to disconnect *from*, and reporting that as a
    // successful no-op tells `/app/exports` the Disconnect worked.
    if (!opts.destinations) {
      sendJSON(res, 503, { error: "notion export not configured" });
      return;
    }
    sendJSON(res, 200, { removed: opts.destinations.remove(principal.userId, "notion") });
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/exports/email") {
    const principal = principalFor(req, url, opts);
    if (!principal) {
      sendJSON(res, 401, { error: "unauthorized" });
      return;
    }
    if (!opts.emailVerifications || !opts.sendEmail || !opts.destinations || !opts.publicBaseUrl) {
      sendJSON(res, 503, { error: "email export not configured" });
      return;
    }
    // The relay sends mail to whatever address this call names, so an
    // unlimited caller could use it to deliver mail to strangers. Checked
    // before the body is even read — deliberately: a typo'd address still
    // spends budget, but that is the right trade for abuse resistance, since
    // the alternative (parse first) lets a caller retry a bad address for
    // free and never actually pay for the attempts that matter.
    if (!emailLimiter.allow(principal.deviceId)) {
      sendJSON(res, 429, { error: "too many verification emails" });
      return;
    }
    let body: Buffer;
    try {
      body = await readBody(req, MAX_REGISTRATION_BYTES);
    } catch {
      sendJSON(res, 413, { error: "body too large" });
      return;
    }
    let address: unknown;
    try {
      address = (JSON.parse(body.toString("utf8")) as { address?: unknown } | null)?.address;
    } catch {
      sendJSON(res, 400, { error: "invalid json" });
      return;
    }
    if (typeof address !== "string" || !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(address)) {
      sendJSON(res, 400, { error: "invalid address" });
      return;
    }
    const token = opts.emailVerifications.mint(principal.userId, address);
    const link = `${opts.publicBaseUrl.replace(/\/$/, "")}/v1/exports/email/confirm?token=${token}`;
    // Sent before the destination is written: a 502 here must leave any
    // existing (possibly already-verified) destination untouched, rather
    // than wiping a working address out from under the user just because
    // the replacement one failed to send.
    try {
      await opts.sendEmail({
        to: address,
        subject: "Confirm transcript delivery",
        text:
          `Confirm this address to start receiving your caption transcripts:\n\n${link}\n\n` +
          `If you did not ask for this, ignore this message and nothing will be sent.`,
      });
    } catch (err) {
      console.error("verification email failed:", err);
      sendJSON(res, 502, { error: "could not send verification email" });
      return;
    }
    opts.destinations.putEmail(principal.userId, { address });
    sendJSON(res, 200, { pending: true });
    return;
  }

  // Followed from an inbox, so there is no bearer token. The single-use token
  // is the proof, and it proves control of the address — which is the point.
  if (req.method === "GET" && url.pathname === "/v1/exports/email/confirm") {
    // Keyed on the address rather than a device, because this request
    // carries no credential at all — it arrives from the user's inbox.
    // Spent before the token is looked at, so a caller cycling guesses pays
    // for every attempt rather than only for the ones that hit a real row.
    if (!confirmLimiter.allow(clientAddress(req, opts.trustProxyHeaders ?? false))) {
      sendJSON(res, 429, { error: "too many confirmation attempts" });
      return;
    }
    const token = url.searchParams.get("token");
    const claim = token && opts.emailVerifications ? opts.emailVerifications.consume(token) : null;
    if (!claim || !opts.destinations) {
      res.writeHead(302, { location: "/app/exports?email=failed" });
      res.end();
      return;
    }
    opts.destinations.putEmail(claim.userId, {
      address: claim.address,
      verifiedAt: new Date().toISOString(),
    });
    res.writeHead(302, { location: "/app/exports?email=confirmed" });
    res.end();
    return;
  }

  if (req.method === "DELETE" && url.pathname === "/v1/exports/email") {
    const principal = principalFor(req, url, opts);
    if (!principal) {
      sendJSON(res, 401, { error: "unauthorized" });
      return;
    }
    // Same as the Notion route above: no store, nothing to remove, so this
    // fails closed rather than reporting a no-op as a successful delete.
    if (!opts.destinations) {
      sendJSON(res, 503, { error: "email export not configured" });
      return;
    }
    // A still-valid confirmation link must not be able to recreate the
    // destination this just deleted, already verified.
    opts.emailVerifications?.deleteForUser(principal.userId);
    sendJSON(res, 200, { removed: opts.destinations.remove(principal.userId, "email") });
    return;
  }

  res.writeHead(404);
  res.end();
}

/** Where the media-stream token lives, since Twilio drops the query string. */
const TWILIO_STREAM_PREFIX = "/twilio/stream/";

/** A malformed percent-escape is a bad token, not a crash. */
function safeDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function flatten(events: { seq: number; payload: OutboundMessage }[]) {
  return events.map((e) => ({ seq: e.seq, ...e.payload }));
}

/**
 * The principal behind a request.
 *
 * The header is the real channel. The query string is still read for the two
 * cases that cannot send a header: Twilio's media-stream client, which drops
 * the query string and gets its token from the path instead, and its webhooks,
 * which we do not control.
 */
function principalFor(
  req: IncomingMessage,
  url: URL,
  opts: StartServerOptions,
): Principal | null {
  const header = bearerToken(req.headers.authorization);
  const token = header ?? url.searchParams.get("token") ?? undefined;
  return resolveToken(opts.identity, token);
}

/**
 * Constant-time string comparison. `adminToken` is the one shared secret
 * left in the system now that every other route resolves a per-device
 * principal, which makes it the one comparison worth closing the timing
 * side-channel on. `timingSafeEqual` throws on a length mismatch rather than
 * returning false, so lengths are compared first — a length check does leak
 * length, but not any byte of the secret, and comparing lengths up front
 * fails closed rather than throwing past the caller.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Carry a merged-away user's transcripts to their new owner.
 *
 * Files are moved individually rather than by renaming the directory, because
 * the destination usually already exists. A failure here leaves the transcript
 * where it was rather than losing it — pairing has already succeeded in the
 * database, and a stranded file is recoverable in a way a deleted one is not.
 *
 * Two further failure modes get the same treatment:
 *  - A name already present on the destination side (both users happened to
 *    record a same-named transcript) is left where it is rather than
 *    silently overwritten by `renameSync`, which would otherwise clobber the
 *    destination user's file with no way to notice.
 *  - The old directory is only removed once every entry has actually moved.
 *    If anything was left behind — a collision or any other per-file
 *    failure — the directory (and the stranded file inside it) is left on
 *    disk rather than deleted out from under the very files this function
 *    just decided not to lose. The removal itself uses the non-recursive
 *    `rmdirSync`, not `rmSync(..., { recursive: true })`, so this is a
 *    filesystem-enforced invariant rather than something the `stranded`
 *    count merely has to get right: a session still in flight under the old
 *    userId can call `TranscriptStore.append`, which recreates this very
 *    directory and writes into it — if that happens to land between the
 *    `stranded` count settling at zero and the removal, `rmdirSync` fails
 *    with `ENOTEMPTY` (caught below) instead of deleting the file that just
 *    arrived along with the directory it landed in.
 */
function moveTranscripts(root: string, fromUserId: string, toUserId: string): void {
  let from: string;
  let to: string;
  try {
    from = userDir(root, fromUserId);
    to = userDir(root, toUserId);
  } catch (err) {
    // userDir throws on a userId that fails its allowlist. Real ids are
    // server-generated UUIDs, so this should not fire in practice — but the
    // pairing already committed in the database, so this must not escape as
    // an unhandled rejection or a 500 for a claim that already succeeded.
    console.error("could not resolve transcript directories during pairing:", err);
    return;
  }
  if (!existsSync(from)) return;

  let entries: string[];
  try {
    mkdirSync(to, { recursive: true });
    entries = readdirSync(from);
  } catch (err) {
    console.error("could not prepare transcript move during pairing:", err);
    warnStranded(root, fromUserId, toUserId);
    return;
  }

  let stranded = 0;
  for (const entry of entries) {
    // Only what a transcript is actually made of, matching
    // `tenantMigration.ts`'s allowlist rather than moving whatever is found.
    // Both sides are per-user directories today, so this changes nothing —
    // but the two functions do the same job and disagreeing about what a
    // transcript is invites the day a `DB_PATH` (or anything else) is pointed
    // inside one and gets carried off by a pairing.
    if (!TRANSCRIPT_SUFFIXES.some((suffix) => entry.endsWith(suffix))) continue;
    const dest = join(to, entry);
    if (existsSync(dest)) {
      console.error(`could not move ${entry} during pairing: ${dest} already exists`);
      stranded += 1;
      continue;
    }
    try {
      renameSync(join(from, entry), dest);
    } catch (err) {
      console.error(`could not move ${entry} during pairing:`, err);
      stranded += 1;
    }
  }

  if (stranded > 0) {
    warnStranded(root, fromUserId, toUserId, stranded);
    return;
  }
  try {
    rmdirSync(from);
  } catch {
    // Non-empty (something landed here after the loop above finished) or
    // otherwise unremovable — not worth failing the pairing over either way.
  }
}

/**
 * Tell the operator, in terms they can act on, that a pairing left files
 * behind.
 *
 * `claimPairingCode` commits — and deletes the emptied `users` row — before
 * any file moves. So by the time a move fails, the directory left on disk
 * belongs to a user id no device resolves to anymore: the transcripts are
 * intact but unreachable through every API, and nothing sweeps or re-adopts
 * them. Recovering them means moving the files by hand.
 *
 * Deliberately one loud line naming both directories and both user ids,
 * rather than only the per-file errors above (which say what failed but not
 * what it costs, or where to look). Boot-time re-adoption of a directory in
 * this state is the real fix and is not built; until it is, this log is the
 * only thing standing between a failed rename and someone's transcripts being
 * lost in practice.
 */
function warnStranded(
  root: string,
  fromUserId: string,
  toUserId: string,
  count?: number,
): void {
  // Resolving can itself throw on an id that fails `userDir`'s allowlist —
  // and this runs from `catch` blocks on a request whose pairing already
  // succeeded, so it must not become the thing that fails that request.
  let from = `<${fromUserId}'s directory under ${root}>`;
  let to = `<${toUserId}'s directory under ${root}>`;
  try {
    from = userDir(root, fromUserId);
    to = userDir(root, toUserId);
  } catch {
    // Keep the descriptive placeholders; the ids below are the load-bearing part.
  }
  const what = count === undefined ? "transcripts" : `${count} transcript file(s)`;
  console.error(
    `PAIRING LEFT TRANSCRIPTS STRANDED: ${what} remain in ${from}, which belongs to user ` +
      `${fromUserId} — a user retired by this pairing, so no device resolves to it and nothing ` +
      `reads that directory anymore. The files are intact on disk but unreachable until an ` +
      `operator moves them into ${to} (user ${toUserId}) by hand. Nothing retries this.`,
  );
}

function sendJSON(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function handleConnection(
  ws: WebSocket,
  opts: StartServerOptions,
  userId: string,
  providerOpts?: ProviderOptions,
): void {
  const provider = opts.createProvider(providerOpts);
  const sessionId = randomUUID();
  const send = (message: OutboundMessage) => {
    if (message.type === "caption" && message.isFinal) {
      opts.transcripts?.append(userId, sessionId, message.text, message.channel);
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };
  const session = new CaptionSession(provider, send);

  let closed = false;
  const closeOnce = () => {
    if (closed) return;
    closed = true;
    session.close();
    opts.transcripts?.finalize(userId, sessionId);
  };

  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      session.handleAudio(data);
      return;
    }
    // A text control frame. Recognized shapes:
    //   - `{"finish":true}` starts the provider's graceful-finish handshake
    //     (needed by the Apple provider, which only emits its true final
    //     result after one — Deepgram finalizes on VAD pauses during the
    //     stream and doesn't need this) while the socket stays open, so the
    //     eventual final caption still has somewhere to go. The client is
    //     expected to close once it has that final; the ordinary `close`
    //     handler below finalizes the transcript then, same as ever.
    //   - `{"caption":{"text":"...","isFinal":true|false}}` is a caption the
    //     client (an on-device transcriber) computed itself, for a session
    //     with no audio ever arriving. Routed into `session.injectTranscript`
    //     — the exact handling a transcript from the wired provider gets — so
    //     it is indistinguishable downstream: same store write, same
    //     live-viewer fan-out, same finalize-on-close semantics. Audio and
    //     caption frames may freely interleave on the same session.
    // Anything else — malformed JSON, an unrecognized shape, a malformed
    // `caption` payload — is silently ignored, same as always: no reply, no
    // close, the session stays exactly as it was.
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }
    const frame = parsed as { finish?: unknown; caption?: unknown } | null;
    if (frame?.finish === true) {
      session.close();
      return;
    }
    const caption = frame?.caption;
    if (caption && typeof caption === "object") {
      const { text, isFinal } = caption as { text?: unknown; isFinal?: unknown };
      if (typeof text === "string" && typeof isFinal === "boolean") {
        session.injectTranscript({ text, isFinal });
      }
    }
  });
  ws.on("close", closeOnce);
  ws.on("error", closeOnce);
}
