/**
 * Five seconds of mu-law at 8 kHz. Named distinctly because `server.ts`
 * already has a `MAX_AUDIO_BYTES` governing request-body size, and the call
 * routes use both in the same file.
 */
export const MAX_BUFFERED_AUDIO_BYTES = 40_000;

interface Chunk {
  seq: number;
  data: Buffer;
}

/** One user's waiting audio and their ever-climbing cursor. */
interface UserBuffer {
  chunks: Chunk[];
  seq: number;
  bytes: number;
}

/**
 * Each user's caller audio waiting for their watch to collect it.
 *
 * Bounded per user, dropping oldest. This is live audio: if the watch stalls,
 * keeping the backlog would only play stale speech and put the listener
 * further behind. Five seconds rides out a slow poll without letting what you
 * hear drift badly out of step with what you read.
 *
 * Keyed by `userId`, following `CurrentCall`'s pattern: the downlink is what
 * the watch literally plays into the room, so with one shared buffer any
 * self-registered device could poll a stranger's caller out loud — and drain
 * it out from under the watch that should have played it.
 *
 * Entries are created lazily and NEVER evicted — not on `clear()`, not
 * between a user's calls, not ever. That is load-bearing, not laziness: each
 * entry's `seq` must keep climbing across that user's calls (see `clear`),
 * and evicting the entry and recreating it later would restart `seq` at 0 —
 * silently resurrecting the skipped-opening-seconds bug `clear`'s comment
 * pins, with every single-call test still green. Growth is bounded the same
 * way `CurrentCall`'s is: one entry per user who has ever had a call, and a
 * new entry costs an attacker a whole registration, which the registration
 * rate limiter already caps.
 */
export class CallAudioBuffer {
  private readonly buffers = new Map<string, UserBuffer>();

  constructor(private readonly maxBytes: number = MAX_BUFFERED_AUDIO_BYTES) {}

  append(userId: string, data: Buffer): void {
    if (data.length === 0) return;
    const buffer = this.forUser(userId);
    buffer.seq += 1;
    buffer.chunks.push({ seq: buffer.seq, data });
    buffer.bytes += data.length;
    while (buffer.bytes > this.maxBytes && buffer.chunks.length > 0) {
      buffer.bytes -= buffer.chunks.shift()!.data.length;
    }
  }

  /** Everything of `userId`'s with a sequence past `since`, plus their newest sequence. */
  drain(userId: string, since: number): { audio: Buffer; seq: number } {
    const buffer = this.buffers.get(userId);
    if (!buffer) return { audio: Buffer.alloc(0), seq: 0 };
    const fresh = buffer.chunks.filter((chunk) => chunk.seq > since);
    return {
      audio: fresh.length > 0 ? Buffer.concat(fresh.map((c) => c.data)) : Buffer.alloc(0),
      seq: buffer.seq,
    };
  }

  /**
   * Drop everything waiting for `userId`, so their next call never inherits
   * this one's audio.
   *
   * **`seq` is deliberately not reset**, and that is load-bearing rather than
   * an oversight. The watch's `CallAudio.reset()` puts its cursor back to 0 at
   * the start of every call; that is only safe because this counter keeps
   * climbing across calls, so a cursor of 0 is always behind whatever arrives
   * next. Reset `seq` here and a watch still holding the previous call's
   * cursor would silently skip the new call's opening seconds as
   * already-heard — and nothing would look wrong from either side.
   * `callAudioBuffer.test.ts` pins the invariant, per user.
   */
  clear(userId: string): void {
    const buffer = this.buffers.get(userId);
    if (!buffer) return;
    buffer.chunks = [];
    buffer.bytes = 0;
  }

  private forUser(userId: string): UserBuffer {
    const existing = this.buffers.get(userId);
    if (existing) return existing;
    const created: UserBuffer = { chunks: [], seq: 0, bytes: 0 };
    this.buffers.set(userId, created);
    return created;
  }
}
