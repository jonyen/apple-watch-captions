import { WebSocketServer, WebSocket } from "ws";
import { createServer, Server, IncomingMessage, ServerResponse } from "http";
import { AddressInfo } from "net";
import { verifyToken } from "./auth";
import { CaptionSession, OutboundMessage } from "./captionSession";
import { TranscriptionProvider } from "./transcriptionProvider";
import { SessionStore } from "./sessionStore";

export interface StartServerOptions {
  port: number;
  authToken: string;
  /** Factory for a fresh provider per connection/session (Deepgram in prod, fake in tests). */
  createProvider: () => TranscriptionProvider;
}

export interface CaptionServer {
  address(): AddressInfo | string | null;
  close(): Promise<void>;
}

/** Cap on a single audio POST body (~512 KB ≈ 16 s of 16 kHz mono Int16). */
const MAX_AUDIO_BYTES = 512 * 1024;
const REAP_INTERVAL_MS = 5_000;

export function startServer(opts: StartServerOptions): CaptionServer {
  const store = new SessionStore({ createProvider: opts.createProvider });
  const reaper = setInterval(() => store.reapIdle(), REAP_INTERVAL_MS);

  const http: Server = createServer((req, res) => {
    handleRequest(req, res, opts, store).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  // The WebSocket endpoint is retained for testing from a real computer; the
  // watch uses the HTTP endpoints (watchOS blocks WebSockets — see TN3135).
  const wss = new WebSocketServer({ noServer: true });
  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "", "http://localhost");
    if (url.pathname !== "/stream") {
      socket.destroy();
      return;
    }
    const token = url.searchParams.get("token") ?? undefined;
    if (!verifyToken(token, opts.authToken)) {
      wss.handleUpgrade(req, socket, head, (ws) => ws.close(4001, "unauthorized"));
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws, opts));
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
): Promise<void> {
  const url = new URL(req.url ?? "", "http://localhost");

  // Health checks.
  if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/")) {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
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
      let body: Buffer;
      try {
        body = await readBody(req, MAX_AUDIO_BYTES);
      } catch {
        sendJSON(res, 413, { error: "body too large" });
        return;
      }
      store.feed(session, body);
      const { events, seq } = store.drain(session, since);
      sendJSON(res, 200, { events: flatten(events), seq });
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

function handleConnection(ws: WebSocket, opts: StartServerOptions): void {
  const provider = opts.createProvider();
  const send = (message: OutboundMessage) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };
  const session = new CaptionSession(provider, send);

  let closed = false;
  const closeOnce = () => {
    if (closed) return;
    closed = true;
    session.close();
  };

  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) session.handleAudio(data);
  });
  ws.on("close", closeOnce);
  ws.on("error", closeOnce);
}
