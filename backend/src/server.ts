import { WebSocketServer, WebSocket } from "ws";
import { createServer, Server, IncomingMessage, ServerResponse } from "http";
import { AddressInfo } from "net";
import { randomUUID, timingSafeEqual } from "crypto";
import { bearerToken, resolveToken } from "./auth";
import { IdentityStore, DeviceKind, Principal } from "./identityStore";
import { CaptionSession, OutboundMessage } from "./captionSession";
import { TranscriptionProvider } from "./transcriptionProvider";
import { SessionStore } from "./sessionStore";
import { CurrentCall } from "./currentCall";
import { ReaderPresence } from "./readerPresence";
import { SettingsStore } from "./settingsStore";
import { handleTwilioStream, TwilioSocketLike } from "./twilioStreamHandler";
import {
  TranscriptStore,
  listTranscripts,
  readTranscript,
  readExportStatus,
  deleteTranscript,
  userDir,
} from "./transcriptStore";
import { VIEWER_HTML } from "./viewerPage";
import type { ReportData } from "./usageReport";
import { PROVIDER_NAMES, ProviderOptions } from "./providerOptions";
import { voiceResponse } from "./twiml";

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
  /** Optional path the phone-written settings persist to. Memory-only without it. */
  settingsFile?: string;
}

export interface CaptionServer {
  address(): AddressInfo | string | null;
  close(): Promise<void>;
}

/** Cap on a single audio POST body (~512 KB ≈ 16 s of 16 kHz mono Int16). */
const MAX_AUDIO_BYTES = 512 * 1024;
const REAP_INTERVAL_MS = 5_000;
/** Settings are a handful of scalars; anything larger is not a settings write. */
const MAX_SETTINGS_BYTES = 4 * 1024;
/** A registration body is `{"kind":"watch"}`; anything larger is not one. */
const MAX_REGISTRATION_BYTES = 1024;
const DEVICE_KINDS: DeviceKind[] = ["watch", "phone", "mac"];
/** Registrations allowed per address per window, and the window itself. */
const REGISTRATIONS_PER_WINDOW = 10;
const REGISTRATION_WINDOW_MS = 60 * 60_000;

/**
 * Per-address registration limiter.
 *
 * Registration cannot require a credential — an app has none before it
 * registers — so the only backstop is a rate limit. A junk account costs one
 * table row today; this must be revisited before a free account grants any
 * metered cloud usage.
 */
export class RegistrationLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  allow(address: string): boolean {
    const cutoff = this.now() - REGISTRATION_WINDOW_MS;
    // Opportunistic eviction: an address that registers once and never
    // returns would otherwise hold its key forever — this process never
    // restarts to clear it (Fly runs it with auto_stop_machines off). Swept
    // on every call rather than on a timer, since registrations are rare
    // enough that this stays cheap.
    this.evictStale(cutoff);
    const recent = (this.hits.get(address) ?? []).filter((at) => at > cutoff);
    if (recent.length >= REGISTRATIONS_PER_WINDOW) {
      this.hits.set(address, recent);
      return false;
    }
    recent.push(this.now());
    this.hits.set(address, recent);
    return true;
  }

  /** How many addresses currently hold a bucket. Exposed for testing eviction. */
  size(): number {
    return this.hits.size;
  }

  private evictStale(cutoff: number): void {
    for (const [address, hits] of this.hits) {
      if (hits.every((at) => at <= cutoff)) this.hits.delete(address);
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
  const settings = new SettingsStore(opts.settingsFile);
  const store = new SessionStore({
    // Read at session creation rather than captured at boot, so changing the
    // provider on the phone takes effect on the next session instead of the
    // next deploy.
    createProvider: (providerOpts) =>
      opts.createProvider({ ...providerOpts, provider: settings.get().provider }),
    transcripts: opts.transcripts,
  });
  const currentCall = new CurrentCall();
  const readers = new ReaderPresence();
  const limiter = new RegistrationLimiter();
  const reaper = setInterval(() => store.reapIdle(), REAP_INTERVAL_MS);

  const http: Server = createServer((req, res) => {
    handleRequest(req, res, opts, store, currentCall, readers, settings, limiter).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
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
  settings: SettingsStore,
  limiter: RegistrationLimiter,
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
    const active = calls.current();
    // A call this poller does not own is invisible to them — answered
    // exactly as "no call active", and deliberately without `reason`:
    // `calls.lastReason()` is the call owner's state too, and surfacing it
    // here would tell a stranger that someone else's call just ended, and
    // how. Checked first, and on its own branch, so the session lookup below
    // never runs with a userId that is not the poller's own — `store.has`/
    // `store.drain` must never be handed anyone's id but the caller's.
    if (active && active.userId !== principal.userId) {
      sendJSON(res, 200, { active: false, events: [], seq: since });
      return;
    }
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

  // Settings the phone writes and the watch reads. They live here because the
  // two apps cannot talk to each other: the watch app is standalone, so there
  // is no paired-companion channel between them.
  if (url.pathname === "/v1/settings" && (req.method === "GET" || req.method === "PUT")) {
    const principal = principalFor(req, url, opts);
    if (!principal) {
      sendJSON(res, 401, { error: "unauthorized" });
      return;
    }
    if (req.method === "GET") {
      sendJSON(res, 200, settings.get());
      return;
    }
    let body: Buffer;
    try {
      body = await readBody(req, MAX_SETTINGS_BYTES);
    } catch {
      sendJSON(res, 413, { error: "body too large" });
      return;
    }
    let patch: unknown;
    try {
      patch = JSON.parse(body.toString("utf8"));
    } catch {
      sendJSON(res, 400, { error: "invalid json" });
      return;
    }
    sendJSON(res, 200, settings.update(patch));
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
    const token = bearerToken(req.headers.authorization) ?? url.searchParams.get("token");
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

      store.feed(principal.userId, session, body, ephemeral);
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
    if (isBinary) session.handleAudio(data);
  });
  ws.on("close", closeOnce);
  ws.on("error", closeOnce);
}
