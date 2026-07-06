import { LiveTranscriptionEvents } from "@deepgram/sdk";
import { TranscriptionProvider, Transcript } from "./transcriptionProvider";

/** Subset of the Deepgram live connection we depend on (keeps it testable). */
export interface LiveConnectionLike {
  send(data: Buffer | string): void;
  requestClose(): void;
  on(event: string, cb: (...args: any[]) => void): unknown;
}

/** Subset of the Deepgram client we depend on. */
export interface DeepgramLike {
  listen: {
    live(options?: Record<string, unknown>): LiveConnectionLike;
  };
}

export const DEEPGRAM_LIVE_OPTIONS = {
  model: "nova-2",
  encoding: "linear16",
  sample_rate: 16000,
  channels: 1,
  interim_results: true,
  punctuate: true,
};

/** Deepgram drops the socket after ~10s without audio; KeepAlives prevent that. */
export const KEEPALIVE_INTERVAL_MS = 5_000;
export const KEEPALIVE_MESSAGE = JSON.stringify({ type: "KeepAlive" });

/** Consecutive failed reconnects before we give up and surface an error. */
export const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BACKOFF_MS = [0, 500, 1_000, 2_000, 4_000];

/** Cap on audio buffered while the socket is down (~16s of 16kHz Int16). */
const MAX_BUFFERED_BYTES = 512 * 1024;

/**
 * Deepgram-backed provider that survives connection drops. Deepgram closes
 * live sockets for many reasons (no audio for 10s, server-side rebalancing);
 * instead of surfacing every close as a fatal error, this provider buffers
 * audio and transparently reconnects, emitting an error only after repeated
 * consecutive failures.
 */
export class DeepgramProvider implements TranscriptionProvider {
  private conn!: LiveConnectionLike;
  private transcriptHandler: (t: Transcript) => void = () => {};
  private readyHandler: () => void = () => {};
  private errorHandler: (message: string) => void = () => {};

  private open = false;
  private closed = false; // close() was called; stop reconnecting
  private readyFired = false;
  private failedAttempts = 0;
  private buffered: Buffer[] = [];
  private bufferedBytes = 0;
  private keepAliveTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;

  constructor(private deepgram: DeepgramLike, private optionOverrides?: Record<string, unknown>) {
    this.connect();
  }

  private connect(): void {
    const conn = this.deepgram.listen.live({ ...DEEPGRAM_LIVE_OPTIONS, ...this.optionOverrides });
    this.conn = conn;

    conn.on(LiveTranscriptionEvents.Open, () => {
      if (conn !== this.conn || this.closed) return;
      this.open = true;
      this.failedAttempts = 0;
      this.flushBuffered();
      this.startKeepAlive();
      if (!this.readyFired) {
        this.readyFired = true;
        this.readyHandler();
      }
    });

    conn.on(LiveTranscriptionEvents.Transcript, (data: any) => {
      if (conn !== this.conn) return;
      const text: string = data?.channel?.alternatives?.[0]?.transcript ?? "";
      // Deepgram live sends channel_index on every Results message, even for
      // mono sessions (e.g. [0, 1]). Only tag the transcript with a channel
      // when the session is genuinely multichannel (total > 1); otherwise a
      // mono watch session would get every caption stamped `channel: 0`.
      const idx = Array.isArray(data?.channel_index) ? Number(data.channel_index[0]) : NaN;
      const total = Array.isArray(data?.channel_index) ? Number(data.channel_index[1]) : NaN;
      const channel = total > 1 && !Number.isNaN(idx) ? idx : undefined;
      this.transcriptHandler({
        text,
        isFinal: Boolean(data?.is_final),
        ...(channel !== undefined ? { channel } : {}),
      });
    });

    conn.on(LiveTranscriptionEvents.Error, (err: any) => {
      console.error("deepgram error:", err?.message ?? err);
      this.handleDrop(conn);
    });

    conn.on(LiveTranscriptionEvents.Close, (event: any) => {
      console.warn("deepgram closed:", event?.code ?? "", event?.reason ?? "");
      this.handleDrop(conn);
    });
  }

  /** A connection died. Reconnect with backoff unless we're closing or out of attempts. */
  private handleDrop(conn: LiveConnectionLike): void {
    if (conn !== this.conn || this.closed) return;
    this.open = false;
    this.stopKeepAlive();
    try {
      conn.requestClose(); // Error can fire while the socket is still open
    } catch {
      // already closed
    }
    if (this.reconnectTimer) return; // Error + Close both fired for this conn

    if (this.failedAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.errorHandler("transcription connection lost");
      return;
    }
    const delay =
      RECONNECT_BACKOFF_MS[Math.min(this.failedAttempts, RECONNECT_BACKOFF_MS.length - 1)];
    this.failedAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.closed) this.connect();
    }, delay);
  }

  private flushBuffered(): void {
    for (const chunk of this.buffered) this.conn.send(chunk);
    this.buffered = [];
    this.bufferedBytes = 0;
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      if (this.open) this.conn.send(KEEPALIVE_MESSAGE);
    }, KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = undefined;
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
    if (this.closed) return;
    if (this.open) {
      this.conn.send(chunk);
      return;
    }
    // Socket is down or still opening: buffer so speech isn't lost, dropping
    // the oldest audio if the outage outlasts the cap.
    this.buffered.push(chunk);
    this.bufferedBytes += chunk.length;
    while (this.bufferedBytes > MAX_BUFFERED_BYTES && this.buffered.length > 0) {
      this.bufferedBytes -= this.buffered.shift()!.length;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopKeepAlive();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.conn.requestClose();
  }
}
