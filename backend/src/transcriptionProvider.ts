
export interface Transcript {
  text: string;
  isFinal: boolean;
}

/**
 * Abstraction over a streaming speech-to-text backend.
 * Implementations: DeepgramTranscriptionProvider (prod), FakeTranscriptionProvider (tests).
 */
export interface TranscriptionProvider {
  /** Register a handler called for each transcript the provider emits. */
  onTranscript(handler: (t: Transcript) => void): void;
  /** Register a handler called once the provider is ready to receive audio. */
  onReady(handler: () => void): void;
  /** Register a handler called on a provider error. */
  onError(handler: (message: string) => void): void;
  /** Feed raw PCM audio bytes to the provider. */
  sendAudio(chunk: Buffer): void;
  /** Close the provider connection. */
  close(): void;
}
