import WebSocket from "ws";
import { TranscriptionProvider, Transcript } from "./transcriptionProvider";

/** Subset of a WebSocket connection we depend on (keeps tests socket-free). */
export interface WebSocketLike {
  on(event: string, cb: (...args: any[]) => void): unknown;
  send(data: Buffer | string): void;
  close(): void;
  readyState: number;
}

export const APPLE_DEFAULT_URL = "ws://127.0.0.1:8790";

/** How long `close()` waits for `{"done":true}` before closing anyway. */
export const FINISH_TIMEOUT_MS = 12_000;

export interface AppleProviderOptions {
  /** Wire format of the audio this session will send. Defaults to "pcm16k". */
  format?: "pcm16k" | "mulaw8k";
  /** BCP-47 locale for the session. Sidecar defaults to "en-US" when omitted. */
  locale?: string;
  /** Injectable for tests; defaults to a real `ws` connection. */
  wsFactory?: (url: string) => WebSocketLike;
  /** Overridable for tests; defaults to FINISH_TIMEOUT_MS. */
  finishTimeoutMs?: number;
}

/**
 * Provider backed by the caption-transcriber sidecar (Apple SpeechTranscriber
 * running locally). The sidecar is local and does not drop connections the
 * way Deepgram's cloud sockets do, so there is no reconnect machinery: an
 * unexpected close is a real failure and is surfaced as one.
 *
 * Protocol (docs/superpowers/specs/2026-08-24-imac-relay-local-stt-design.md,
 * "Sidecar protocol"): the FIRST frame after open is a text `{"config":{...}}`
 * frame (no query parameters — Network.framework's WS server can't read the
 * request path). Ending a session is a handshake, not a plain socket close:
 * NWProtocolWebSocket refuses further sends once a peer close is delivered,
 * so the client sends `{"finish":true}`, keeps the socket open, and waits for
 * `{"done":true}` (any transcripts arriving in between are still forwarded —
 * the final result often arrives exactly there) before closing its end. A
 * server-initiated close right after `finish` is therefore expected, not an
 * error.
 */
export class AppleTranscriptionProvider implements TranscriptionProvider {
  private ws: WebSocketLike;
  private opened = false;
  private finishing = false;
  private closed = false;
  /** Set once we've sent `finish` (or already closed): a close is expected. */
  private expectServerClose = false;
  private pending: Buffer[] = [];
  private doneTimer?: ReturnType<typeof setTimeout>;
  private finishTimeoutMs: number = FINISH_TIMEOUT_MS;
  private transcriptHandler: (t: Transcript) => void = () => {};
  private readyHandler: () => void = () => {};
  private errorHandler: (message: string) => void = () => {};

  constructor(url: string = APPLE_DEFAULT_URL, opts: AppleProviderOptions = {}) {
    const wsFactory = opts.wsFactory ?? ((u: string) => new WebSocket(u) as unknown as WebSocketLike);
    this.finishTimeoutMs = opts.finishTimeoutMs ?? FINISH_TIMEOUT_MS;
    this.ws = wsFactory(url);

    this.ws.on("open", () => {
      this.opened = true;
      const config: Record<string, string> = {};
      if (opts.locale) config.locale = opts.locale;
      if (opts.format) config.format = opts.format;
      this.ws.send(JSON.stringify({ config }));
      for (const chunk of this.pending) this.ws.send(chunk);
      this.pending = [];
    });

    this.ws.on("message", (data: Buffer | string) => {
      let parsed: any;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        return;
      }
      if (parsed && parsed.ready === true) {
        this.readyHandler();
      } else if (parsed && typeof parsed.text === "string") {
        this.transcriptHandler({ text: parsed.text, isFinal: !!parsed.isFinal });
      } else if (parsed && typeof parsed.error === "string") {
        // Fatal: the server closes after sending this, so the close that
        // follows is expected, not a second failure.
        this.expectServerClose = true;
        this.errorHandler(parsed.error);
      } else if (parsed && parsed.done === true) {
        this.finishDone();
      }
    });

    this.ws.on("close", () => {
      if (this.expectServerClose || this.closed) return;
      this.errorHandler("transcriber connection lost");
    });

    this.ws.on("error", (err: Error) => {
      if (this.expectServerClose || this.closed) return;
      this.errorHandler(err.message);
    });
  }

  onTranscript(handler: (t: Transcript) => void): void {
    this.transcriptHandler = handler;
  }
  onReady(handler: () => void): void {
    this.readyHandler = handler;
  }
  onError(handler: (message: string) => void): void {
    this.errorHandler = handler;
  }

  sendAudio(chunk: Buffer): void {
    if (this.finishing || this.closed) return;
    if (this.opened) this.ws.send(chunk);
    else this.pending.push(chunk);
  }

  /**
   * Graceful finish: send `{"finish":true}`, keep the socket open, and wait
   * (bounded by `finishTimeoutMs`) for `{"done":true}` before closing — the
   * final transcript often arrives in that window. Audio sent after this
   * call is dropped.
   */
  close(): void {
    if (this.finishing || this.closed) return;
    this.finishing = true;
    if (!this.opened) {
      // Never got a session going; nothing to finish gracefully.
      this.finalizeClose();
      return;
    }
    this.expectServerClose = true;
    this.ws.send(JSON.stringify({ finish: true }));
    this.doneTimer = setTimeout(() => {
      this.doneTimer = undefined;
      this.finalizeClose();
    }, this.finishTimeoutMs);
  }

  private finishDone(): void {
    if (this.doneTimer) {
      clearTimeout(this.doneTimer);
      this.doneTimer = undefined;
    }
    this.finalizeClose();
  }

  private finalizeClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.expectServerClose = true;
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}
