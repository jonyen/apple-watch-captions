
export type CallEndReason = "ended" | "stream_lost";

export interface ActiveCall {
  /** The SessionStore session carrying this call's captions. */
  sessionId: string;
  callSid: string;
  /**
   * The principal that authorised the Twilio media-stream WebSocket. This
   * call's captions belong to them, whoever later polls for them — see
   * `SessionStore`, which is now keyed by user as well as session id.
   */
  userId: string;
}

/**
 * The call each user is currently having, and how their last one ended.
 *
 * Presence is a first-class thing rather than a variable inside a route
 * handler because the watch polls for it: `GET /v1/call` answers "is a call
 * live right now?" and "here are its captions" in the same request.
 *
 * One call at a time **per user**, not per process. A second concurrent call
 * replaces that user's first one, and only theirs: `/twilio/stream` needs
 * nothing but a valid device token and `POST /v1/devices` is open, so with a
 * single global slot any self-registered device could end a stranger's live
 * call simply by sending one `start` frame — the eviction in
 * `twilioStreamHandler` cannot tell whose call it is holding. Keying the slot
 * by user makes that impossible by construction rather than by a check
 * someone has to remember to write.
 *
 * Both maps grow by one entry per user who has ever had a call, and neither
 * is swept. That is deliberate: unlike `ReaderPresence` (whose keys include a
 * client-chosen session id, so one token can mint unlimited entries), a key
 * here costs an attacker a whole registration, which the registration rate
 * limiter already caps.
 */
export class CurrentCall {
  private readonly active = new Map<string, ActiveCall>();
  private readonly reasons = new Map<string, CallEndReason>();

  begin(sessionId: string, callSid: string, userId: string): void {
    this.active.set(userId, { sessionId, callSid, userId });
    this.reasons.delete(userId);
  }

  /**
   * End `sessionId` if it is `userId`'s current call. Returns false when it is
   * not — a socket dying for a call that was already replaced must not clear
   * its replacement. The lookup is by user, so one user's end can never touch
   * another's call even if they somehow share a session id (Twilio `callSid`s,
   * today's session ids, are globally unique, but session ids are in principle
   * chosen by the caller of this method).
   */
  end(sessionId: string, userId: string, reason: CallEndReason): boolean {
    if (this.active.get(userId)?.sessionId !== sessionId) return false;
    this.active.delete(userId);
    this.reasons.set(userId, reason);
    return true;
  }

  /**
   * The call `userId` is having right now, or null. Scoped by caller rather
   * than a plain getter for the same reason `SessionStore` is keyed by user:
   * a call is only ever visible — or replaceable — by the user it belongs to.
   */
  current(userId: string): ActiveCall | null {
    return this.active.get(userId) ?? null;
  }

  /**
   * How `userId`'s most recent call ended, or null if one is live or none has
   * run. Never answers for a call that was not theirs: without the scope, this
   * would tell any authenticated poller that someone else's call just ended,
   * and how.
   */
  lastReason(userId: string): CallEndReason | null {
    return this.reasons.get(userId) ?? null;
  }
}
