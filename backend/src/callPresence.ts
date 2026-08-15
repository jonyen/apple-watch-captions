// backend/src/callPresence.ts

/** How recently the watch must have polled to count as ready for a call. */
export const PRESENCE_WINDOW_MS = 10_000;

/**
 * Whether each user's watch is here right now, inferred from how recently it
 * polled `GET /v1/call` with `ready=1`.
 *
 * Presence deliberately reuses a signal the watch already sends rather than
 * introducing a registration protocol — and it is the signal a push
 * notification would eventually replace.
 *
 * Keyed by `userId`, following `CurrentCall`'s pattern, because presence is
 * what decides where an inbound call goes: with one shared timestamp, any
 * self-registered device saying "ready" would arm `<Connect>` for a
 * stranger's inbound call — their caller handed live to the wrong wrist.
 * `/twilio/voice` resolves its own principal and asks about that user only.
 *
 * The map is never swept. Like `CurrentCall` — and unlike `ReaderPresence`,
 * whose keys include a client-chosen session id one token can mint without
 * limit — a key here costs an attacker a whole registration, which the
 * registration rate limiter already caps. The key is a `userId` alone, never
 * joined with any other id, so a plain map key is unambiguous (contrast the
 * length-prefixed `sessionKey` in `sessionStore.ts`, which joins two).
 */
export class CallPresence {
  private readonly lastSeen = new Map<string, number>();
  private readonly now: () => number;
  private readonly windowMs: number;

  constructor(opts: { now?: () => number; windowMs?: number } = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.windowMs = opts.windowMs ?? PRESENCE_WINDOW_MS;
  }

  mark(userId: string): void {
    this.lastSeen.set(userId, this.now());
  }

  isPresent(userId: string): boolean {
    const seen = this.lastSeen.get(userId);
    if (seen === undefined) return false;
    return this.now() - seen <= this.windowMs;
  }
}
