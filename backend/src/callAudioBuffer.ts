/**
 * Five seconds of mu-law at 8 kHz. Named distinctly because `server.ts`
 * already has a `MAX_AUDIO_BYTES` governing request-body size, and Task 9
 * uses both in the same file.
 */
export const MAX_BUFFERED_AUDIO_BYTES = 40_000;

interface Chunk {
  seq: number;
  data: Buffer;
}

/**
 * The caller's audio waiting for the watch to collect it.
 *
 * Bounded, dropping oldest. This is live audio: if the watch stalls, keeping
 * the backlog would only play stale speech and put the listener further
 * behind. Five seconds rides out a slow poll without letting what you hear
 * drift badly out of step with what you read.
 */
export class CallAudioBuffer {
  private chunks: Chunk[] = [];
  private seq = 0;
  private bytes = 0;

  constructor(private readonly maxBytes: number = MAX_BUFFERED_AUDIO_BYTES) {}

  append(data: Buffer): void {
    if (data.length === 0) return;
    this.seq += 1;
    this.chunks.push({ seq: this.seq, data });
    this.bytes += data.length;
    while (this.bytes > this.maxBytes && this.chunks.length > 0) {
      this.bytes -= this.chunks.shift()!.data.length;
    }
  }

  /** Everything with a sequence past `since`, plus the newest sequence. */
  drain(since: number): { audio: Buffer; seq: number } {
    const fresh = this.chunks.filter((chunk) => chunk.seq > since);
    return {
      audio: fresh.length > 0 ? Buffer.concat(fresh.map((c) => c.data)) : Buffer.alloc(0),
      seq: this.seq,
    };
  }

  clear(): void {
    this.chunks = [];
    this.bytes = 0;
  }
}
