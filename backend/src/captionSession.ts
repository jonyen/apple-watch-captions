import { TranscriptionProvider, Transcript } from "./transcriptionProvider";

export type OutboundMessage =
  | { type: "ready" }
  | { type: "caption"; text: string; isFinal: boolean; channel?: number }
  | { type: "error"; message: string };

/**
 * Wires a TranscriptionProvider to a client send-callback.
 * Provider-agnostic: all production wiring lives in server.ts.
 */
export class CaptionSession {
  constructor(
    private provider: TranscriptionProvider,
    private send: (message: OutboundMessage) => void,
  ) {
    this.provider.onReady(() => this.send({ type: "ready" }));
    this.provider.onTranscript((t) => this.injectTranscript(t));
    this.provider.onError((message) => this.send({ type: "error", message }));
  }

  handleAudio(chunk: Buffer): void {
    this.provider.sendAudio(chunk);
  }

  /**
   * Route a transcript into the same handling a transcript emitted by the
   * wired provider gets — empty-text drop, `caption` message shaping, and the
   * `send` callback (store write + live-viewer fan-out). The provider's own
   * `onTranscript` handler above calls this; server.ts also calls it directly
   * for a client-supplied caption frame (on-device transcription) on
   * /stream, so downstream a caption frame is indistinguishable from one the
   * provider emitted itself.
   */
  injectTranscript(t: Transcript): void {
    if (t.text.length === 0) return;
    this.send({
      type: "caption",
      text: t.text,
      isFinal: t.isFinal,
      ...(t.channel !== undefined ? { channel: t.channel } : {}),
    });
  }

  close(): void {
    this.provider.close();
  }
}
