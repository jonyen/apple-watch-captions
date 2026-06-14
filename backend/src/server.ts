import { WebSocketServer, WebSocket } from "ws";
import { createServer, Server } from "http";
import { AddressInfo } from "net";
import { verifyToken } from "./auth";
import { CaptionSession, OutboundMessage } from "./captionSession";
import { TranscriptionProvider } from "./transcriptionProvider";

export interface StartServerOptions {
  port: number;
  authToken: string;
  /** Factory for a fresh provider per connection (Deepgram in prod, fake in tests). */
  createProvider: () => TranscriptionProvider;
}

export interface CaptionServer {
  address(): AddressInfo | string | null;
  close(): Promise<void>;
}

export function startServer(opts: StartServerOptions): CaptionServer {
  const http: Server = createServer();
  const wss = new WebSocketServer({ noServer: true });

  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "", "http://localhost");
    if (url.pathname !== "/stream") {
      socket.destroy();
      return;
    }
    const token = url.searchParams.get("token") ?? undefined;
    if (!verifyToken(token, opts.authToken)) {
      // 4001 = application-level "unauthorized" close code.
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
        for (const client of wss.clients) client.terminate();
        wss.close(() => http.close(() => resolve()));
      }),
  };
}

function handleConnection(ws: WebSocket, opts: StartServerOptions): void {
  const provider = opts.createProvider();
  const send = (message: OutboundMessage) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };
  const session = new CaptionSession(provider, send);

  // `ws` fires `close` after `error`; guard so the provider is torn down once.
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
