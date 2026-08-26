import { TranscriptionProvider, Transcript } from "./transcriptionProvider";

/**
 * Test double. Records audio and lets tests drive ready/transcript/error events.
 */
export class FakeTranscriptionProvider implements TranscriptionProvider {
  receivedAudio: Buffer[] = [];
  closed = false;
  /**
   * Test hook: when set, `close()` resolves only once this resolves (or
   * rejects when it does), instead of immediately — lets a test simulate a
   * provider whose graceful close takes time (or never finishes on its own),
   * the same shape `AppleTranscriptionProvider`'s finish/done handshake has,
   * so callers that are supposed to wait for it can be proven to actually
   * wait.
   */
  closeBarrier?: Promise<void>;

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
  close(): Promise<void> {
    this.closed = true;
    return this.closeBarrier ?? Promise.resolve();
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
