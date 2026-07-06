import { TranscriptionProvider } from "./transcriptionProvider";

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
    this.provider.onTranscript((t) => {
      if (t.text.length === 0) return;
      this.send({
        type: "caption",
        text: t.text,
        isFinal: t.isFinal,
        ...(t.channel !== undefined ? { channel: t.channel } : {}),
      });
    });
    this.provider.onError((message) => this.send({ type: "error", message }));
  }

  handleAudio(chunk: Buffer): void {
    this.provider.sendAudio(chunk);
  }

  close(): void {
    this.provider.close();
  }
}
