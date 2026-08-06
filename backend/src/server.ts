import { WebSocketServer, WebSocket } from "ws";
import { createServer, Server, IncomingMessage, ServerResponse } from "http";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { verifyToken } from "./auth";
import { CaptionSession, OutboundMessage } from "./captionSession";
import { TranscriptionProvider } from "./transcriptionProvider";
import { SessionStore } from "./sessionStore";
import { CurrentCall } from "./currentCall";
import { handleTwilioStream, TwilioSocketLike } from "./twilioStreamHandler";
import {
  TranscriptStore,
  listTranscripts,
  readTranscript,
  readExportStatus,
  deleteTranscript,
} from "./transcriptStore";
import { VIEWER_HTML } from "./viewerPage";
import type { ReportData } from "./usageReport";
import { PROVIDER_NAMES, ProviderOptions } from "./providerOptions";
import { voiceResponse } from "./twiml";

export * from "./providerOptions";

export interface StartServerOptions {
  port: number;
  authToken: string;
  /** Factory for a fresh provider per connection/session (Deepgram in prod, fake in tests). */
  createProvider: (opts?: ProviderOptions) => TranscriptionProvider;
  /** Optional transcript persistence; also enables the /v1/transcripts endpoints. */
  transcripts?: TranscriptStore;
  /** Directory the transcript endpoints read from (required with `transcripts`). */
  transcriptsDir?: string;
  /** Optional usage data source; enables GET /v1/usage. */
  usage?: { getUsage(): Promise<ReportData> };
  /** Optional; the number an inbound captioned call is bridged to. Enables /twilio/voice. */
  callForwardTo?: string;
}

export interface CaptionServer {
  address(): AddressInfo | string | null;
  close(): Promise<void>;
}

/** Cap on a single audio POST body (~512 KB ≈ 16 s of 16 kHz mono Int16). */
const MAX_AUDIO_BYTES = 512 * 1024;
const REAP_INTERVAL_MS = 5_000;

export function startServer(opts: StartServerOptions): CaptionServer {
  const store = new SessionStore({
    createProvider: opts.createProvider,
    transcripts: opts.transcripts,
  });
  const currentCall = new CurrentCall();
  const reaper = setInterval(() => store.reapIdle(), REAP_INTERVAL_MS);

  const http: Server = createServer((req, res) => {
    handleRequest(req, res, opts, store, currentCall).catch(() => {
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

    if (url.pathname === "/twilio/stream") {
      if (!verifyToken(token, opts.authToken)) {
        wss.handleUpgrade(req, socket, head, (ws) => ws.close(4001, "unauthorized"));
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) =>
        handleTwilioStream(ws as unknown as TwilioSocketLike, store, currentCall));
      return;
    }

    if (url.pathname !== "/stream") {
      socket.destroy();
      return;
    }
    if (!verifyToken(token, opts.authToken)) {
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
    wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws, opts, providerOpts));
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

  // Twilio asks what to do with an inbound call. Answer: fork the caller's
  // audio to this relay, then bridge the call onward.
  if (req.method === "POST" && url.pathname === "/twilio/voice") {
    const token = url.searchParams.get("token") ?? undefined;
    if (!verifyToken(token, opts.authToken)) {
      sendJSON(res, 401, { error: "unauthorized" });
      return;
    }
    if (!opts.callForwardTo) {
      sendJSON(res, 503, { error: "call captioning not configured" });
      return;
    }
    // The host Twilio reached us on is the host it should stream back to, so
    // there is no public-URL setting to keep in sync with the deployment.
    const streamUrl =
      `wss://${req.headers.host ?? ""}/twilio/stream` +
      `?token=${encodeURIComponent(token ?? "")}`;
    res.writeHead(200, { "content-type": "text/xml" });
    res.end(voiceResponse({ streamUrl, dialTo: opts.callForwardTo }));
    return;
  }

  // Presence and captions in one request: the watch uses this both to notice a
  // call is live and to read it. Read-only — unlike /v1/audio it never creates
  // a session, so polling when no call exists costs nothing upstream.
  if (req.method === "GET" && url.pathname === "/v1/call") {
    const token = url.searchParams.get("token") ?? undefined;
    if (!verifyToken(token, opts.authToken)) {
      sendJSON(res, 401, { error: "unauthorized" });
      return;
    }
    const since = Number(url.searchParams.get("since") ?? "0") || 0;
    const active = calls.current();
    // reapIdle (or a direct /v1/stop) can drop a call's session without
    // telling CurrentCall. Left unguarded, this would report `active: true`
    // forever with no captions ever arriving — a screen that hangs rather
    // than ever saying the call ended.
    if (active && !store.has(active.sessionId)) {
      sendJSON(res, 200, { active: false, events: [], seq: since });
      return;
    }
    if (!active) {
      const reason = calls.lastReason();
      sendJSON(res, 200, {
        active: false,
        ...(reason ? { reason } : {}),
        events: [],
        seq: since,
      });
      return;
    }
    const { events, seq } = store.drain(active.sessionId, since);
    sendJSON(res, 200, { active: true, events: flatten(events), seq });
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/v1/transcripts")) {
    if (!opts.transcriptsDir) {
      sendJSON(res, 404, { error: "transcripts not enabled" });
      return;
    }
    const token = url.searchParams.get("token") ?? undefined;
    if (!verifyToken(token, opts.authToken)) {
      sendJSON(res, 401, { error: "unauthorized" });
      return;
    }
    if (url.pathname === "/v1/transcripts") {
      sendJSON(res, 200, { transcripts: listTranscripts(opts.transcriptsDir) });
      return;
    }
    const path = url.pathname.slice("/v1/transcripts/".length);

    // Has this transcript reached Notion yet? Answered on its own so a client
    // waiting on the export can poll it without pulling the whole transcript.
    if (path.endsWith("/export")) {
      const name = decodeURIComponent(path.slice(0, -"/export".length));
      const status = readExportStatus(opts.transcriptsDir, name);
      if (!status) {
        sendJSON(res, 404, { error: "not found" });
        return;
      }
      sendJSON(res, 200, status);
      return;
    }

    const name = decodeURIComponent(path);
    const detail = readTranscript(opts.transcriptsDir, name);
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
    if (!opts.transcriptsDir) {
      sendJSON(res, 404, { error: "transcripts not enabled" });
      return;
    }
    const token = url.searchParams.get("token") ?? undefined;
    if (!verifyToken(token, opts.authToken)) {
      sendJSON(res, 401, { error: "unauthorized" });
      return;
    }
    const name = decodeURIComponent(url.pathname.slice("/v1/transcripts/".length));
    if (!deleteTranscript(opts.transcriptsDir, name)) {
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
    const token = url.searchParams.get("token") ?? undefined;
    if (!verifyToken(token, opts.authToken)) {
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
    const token = url.searchParams.get("token") ?? undefined;
    if (!verifyToken(token, opts.authToken)) {
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
      if (resume && !ephemeral && !store.has(session)) {
        opts.transcripts?.reopen(session, resume);
      }

      let body: Buffer;
      try {
        body = await readBody(req, MAX_AUDIO_BYTES);
      } catch {
        sendJSON(res, 413, { error: "body too large" });
        return;
      }
      store.feed(session, body, ephemeral);
      const { events, seq } = store.drain(session, since);
      sendJSON(res, 200, {
        events: flatten(events),
        seq,
        // Names the transcript this session is writing to, so the client can
        // resume it later. Absent until the first caption creates the file —
        // and always absent for a live session, which creates none. Asking the
        // store rather than the query string keeps the answer stable for the
        // whole session, even if a later post drops the flag.
        transcript: store.isEphemeral(session)
          ? undefined
          : opts.transcripts?.activeName(session),
      });
      return;
    }

    // /v1/stop — drain any remaining events, then tear the session down.
    const { events, seq } = store.drain(session, since);
    store.stop(session);
    sendJSON(res, 200, { events: flatten(events), seq });
    return;
  }

  res.writeHead(404);
  res.end();
}

function flatten(events: { seq: number; payload: OutboundMessage }[]) {
  return events.map((e) => ({ seq: e.seq, ...e.payload }));
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
  providerOpts?: ProviderOptions,
): void {
  const provider = opts.createProvider(providerOpts);
  const sessionId = randomUUID();
  const send = (message: OutboundMessage) => {
    if (message.type === "caption" && message.isFinal) {
      opts.transcripts?.append(sessionId, message.text, message.channel);
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };
  const session = new CaptionSession(provider, send);

  let closed = false;
  const closeOnce = () => {
    if (closed) return;
    closed = true;
    session.close();
    opts.transcripts?.finalize(sessionId);
  };

  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) session.handleAudio(data);
  });
  ws.on("close", closeOnce);
  ws.on("error", closeOnce);
}
