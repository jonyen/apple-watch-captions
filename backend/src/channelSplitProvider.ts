import { TranscriptionProvider, Transcript } from "./transcriptionProvider";

/**
 * Adapts a mono-only transcription backend to the mac app's 2-channel
 * interleaved stream (ch0 = mic, ch1 = system audio): de-interleaves the
 * stereo Int16 PCM into two mono streams, runs one inner provider per
 * channel, and tags each transcript with its channel index.
 *
 * Ready fires once both inner providers are ready; the first inner error is
 * surfaced (once) and the whole pair is torn down.
 */
export class ChannelSplitProvider implements TranscriptionProvider {
  private readonly inner: [TranscriptionProvider, TranscriptionProvider];
  private transcriptHandler: (t: Transcript) => void = () => {};
  private readyHandler: () => void = () => {};
  private errorHandler: (message: string) => void = () => {};

  private readyCount = 0;
  private errored = false;
  /** Trailing bytes of a chunk that didn't end on a stereo-frame boundary. */
  private remainder: Buffer = Buffer.alloc(0);

  constructor(createMono: () => TranscriptionProvider) {
    this.inner = [createMono(), createMono()];
    this.inner.forEach((provider, channel) => {
      provider.onReady(() => {
        this.readyCount += 1;
        if (this.readyCount === 2) this.readyHandler();
      });
      provider.onTranscript((t) => this.transcriptHandler({ ...t, channel }));
      provider.onError((message) => {
        if (this.errored) return;
        this.errored = true;
        this.errorHandler(message);
      });
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
    const data = this.remainder.length > 0 ? Buffer.concat([this.remainder, chunk]) : chunk;
    // One stereo frame = two little-endian Int16 samples = 4 bytes.
    const frames = Math.floor(data.length / 4);
    this.remainder = data.subarray(frames * 4);
    if (frames === 0) return;

    const left = Buffer.alloc(frames * 2);
    const right = Buffer.alloc(frames * 2);
    for (let f = 0; f < frames; f++) {
      data.copy(left, f * 2, f * 4, f * 4 + 2);
      data.copy(right, f * 2, f * 4 + 2, f * 4 + 4);
    }
    this.inner[0].sendAudio(left);
    this.inner[1].sendAudio(right);
  }

  close(): void {
    for (const provider of this.inner) provider.close();
  }
}
