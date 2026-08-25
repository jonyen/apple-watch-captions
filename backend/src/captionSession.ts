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
    /**
     * Optional training-data hook: called with every raw PCM chunk handed to
     * `handleAudio`, alongside (not instead of) forwarding it to the
     * provider. Only ever wired for a session that genuinely carries audio —
     * `server.ts`/`sessionStore.ts` omit it for caption-only and ephemeral
     * sessions. Any failure here must never come back to break captioning,
     * so callers are expected to swallow their own errors (see
     * `TrainingCapture.audio`) rather than relying on a try/catch here.
     */
    private onAudio?: (chunk: Buffer) => void,
  ) {
    this.provider.onReady(() => this.send({ type: "ready" }));
    this.provider.onTranscript((t) => this.injectTranscript(t));
    this.provider.onError((message) => this.send({ type: "error", message }));
  }

  handleAudio(chunk: Buffer): void {
    this.provider.sendAudio(chunk);
    this.onAudio?.(chunk);
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
