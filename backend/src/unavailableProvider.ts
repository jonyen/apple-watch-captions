import { TranscriptionProvider, Transcript } from "./transcriptionProvider";

/**
 * Stand-in for a provider the relay isn't configured for (missing API key):
 * immediately reports the reason as a session error. The microtask delay lets
 * CaptionSession register its handlers first (it constructs synchronously
 * right after the provider factory returns).
 */
export class UnavailableProvider implements TranscriptionProvider {
  private errorHandler: (message: string) => void = () => {};

  constructor(message: string) {
    queueMicrotask(() => this.errorHandler(message));
  }

  onTranscript(_handler: (t: Transcript) => void): void {}
  onReady(_handler: () => void): void {}
  onError(handler: (message: string) => void): void {
    this.errorHandler = handler;
  }
  sendAudio(_chunk: Buffer): void {}
  close(): void {}
}
