// backend/src/callPresence.ts

/** How recently the watch must have polled to count as ready for a call. */
export const PRESENCE_WINDOW_MS = 10_000;

/**
 * Whether the watch is here right now, inferred from how recently it polled
 * `GET /v1/call`.
 *
 * Presence deliberately reuses a signal the watch already sends rather than
 * introducing a registration protocol — and it is the signal a push
 * notification would eventually replace.
 */
export class CallPresence {
  private lastSeen = Number.NEGATIVE_INFINITY;
  private readonly now: () => number;
  private readonly windowMs: number;

  constructor(opts: { now?: () => number; windowMs?: number } = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.windowMs = opts.windowMs ?? PRESENCE_WINDOW_MS;
  }

  mark(): void {
    this.lastSeen = this.now();
  }

  isPresent(): boolean {
    return this.now() - this.lastSeen <= this.windowMs;
  }
}
