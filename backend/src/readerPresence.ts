/** How recently a session must have been read to count as being watched. */
const DEFAULT_WINDOW_MS = 10_000;

/**
 * Presence is per user as well as per session, for the same reason
 * `SessionStore` is keyed that way: session ids are client-chosen and not
 * secret, so keying on id alone would let one user's presence answer another
 * user's question.
 *
 * Length-prefixed rather than a plain `${userId}:${sessionId}` join — see
 * `sessionKey` in `sessionStore.ts` for why a plain join is not injective.
 */
function presenceKey(userId: string, sessionId: string): string {
  return `${userId.length}:${userId}:${sessionId}`;
}

export interface ReaderPresenceOptions {
  /** How long a mark counts for. */
  windowMs?: number;
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
}

/**
 * Who is reading a session right now.
 *
 * The phone streams audio only while something is actually watching, so it has
 * to be able to ask. Presence is a named concept rather than a timestamp buried
 * in a route handler because two different requests need it: the watch marks it
 * by reading, and the phone reads it to decide whether to send anything at all.
 *
 * "Present" means read within the window. Deliberately not a connect/disconnect
 * protocol: watchOS allows no persistent connection here (TN3135), so there is
 * no disconnect to observe — only the absence of further polls. A window turns
 * that absence into an answer without either side registering anything.
 */
export class ReaderPresence {
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly lastSeen = new Map<string, number>();
  private readonly lastFed = new Map<string, number>();

  constructor(opts: ReaderPresenceOptions = {}) {
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Record that `userId` just read `sessionId`. */
  mark(userId: string, sessionId: string): void {
    this.lastSeen.set(presenceKey(userId, sessionId), this.now());
  }

  /** True when `userId` read `sessionId` within the window. */
  isPresent(userId: string, sessionId: string): boolean {
    const key = presenceKey(userId, sessionId);
    const seen = this.lastSeen.get(key);
    if (seen === undefined) return false;
    if (this.now() - seen > this.windowMs) {
      // Drop it on the way past rather than sweeping on a timer: this is asked
      // about once a session, so entries expire exactly when someone looks.
      this.lastSeen.delete(key);
      return false;
    }
    return true;
  }

  /** Record that `userId` just fed `sessionId` audio by whatever produces it. */
  markProducer(userId: string, sessionId: string): void {
    this.lastFed.set(presenceKey(userId, sessionId), this.now());
  }

  /**
   * True when `userId` fed `sessionId` within the window.
   *
   * The mirror of `isPresent`, and what lets the watch open straight into
   * captions when the phone is already broadcasting — the same trick launching
   * into a live call uses, pointed at the phone instead.
   */
  isProducing(userId: string, sessionId: string): boolean {
    const key = presenceKey(userId, sessionId);
    const fed = this.lastFed.get(key);
    if (fed === undefined) return false;
    if (this.now() - fed > this.windowMs) {
      this.lastFed.delete(key);
      return false;
    }
    return true;
  }

  /** Forget `userId`'s presence on `sessionId`, for a reader that has explicitly left. */
  clear(userId: string, sessionId: string): void {
    const key = presenceKey(userId, sessionId);
    this.lastSeen.delete(key);
    this.lastFed.delete(key);
  }
}
