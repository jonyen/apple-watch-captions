import { LiveTranscriptionEvents } from "@deepgram/sdk";
import { TranscriptionProvider, Transcript } from "./transcriptionProvider";

/** Subset of the Deepgram live connection we depend on (keeps it testable). */
export interface LiveConnectionLike {
  send(data: Buffer): void;
  finish(): void;
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

export class DeepgramProvider implements TranscriptionProvider {
  private conn: LiveConnectionLike;
  private transcriptHandler: (t: Transcript) => void = () => {};
  private readyHandler: () => void = () => {};
  private errorHandler: (message: string) => void = () => {};

  constructor(deepgram: DeepgramLike) {
    this.conn = deepgram.listen.live(DEEPGRAM_LIVE_OPTIONS);
    this.conn.on(LiveTranscriptionEvents.Open, () => this.readyHandler());
    this.conn.on(LiveTranscriptionEvents.Transcript, (data: any) => {
      const text: string =
        data?.channel?.alternatives?.[0]?.transcript ?? "";
      this.transcriptHandler({ text, isFinal: Boolean(data?.is_final) });
    });
    this.conn.on(LiveTranscriptionEvents.Error, (err: any) => {
      this.errorHandler(err?.message ?? "deepgram error");
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
    this.conn.send(chunk);
  }
  close(): void {
    this.conn.finish();
  }
}
