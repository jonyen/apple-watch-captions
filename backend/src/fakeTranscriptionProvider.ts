import { TranscriptionProvider, Transcript } from "./transcriptionProvider";

/**
 * Test double. Records audio and lets tests drive ready/transcript/error events.
 */
export class FakeTranscriptionProvider implements TranscriptionProvider {
  receivedAudio: Buffer[] = [];
  closed = false;

  private transcriptHandler: (t: Transcript) => void = () => {};
  private readyHandler: () => void = () => {};
  private errorHandler: (message: string) => void = () => {};

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
    this.receivedAudio.push(chunk);
  }
  close(): void {
    this.closed = true;
  }

  // --- test drivers ---
  emitReady(): void {
    this.readyHandler();
  }
  emitTranscript(t: Transcript): void {
    this.transcriptHandler(t);
  }
  emitError(message: string): void {
    this.errorHandler(message);
  }
}
