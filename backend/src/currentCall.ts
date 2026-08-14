
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
 * The one call the relay is currently captioning, and how the last one ended.
 *
 * Presence is a first-class thing rather than a variable inside a route
 * handler because the watch polls for it: `GET /v1/call` answers "is a call
 * live right now?" and "here are its captions" in the same request.
 *
 * One call at a time. A second concurrent call replaces the first.
 */
export class CurrentCall {
  private active: ActiveCall | null = null;
  private reason: CallEndReason | null = null;

  begin(sessionId: string, callSid: string, userId: string): void {
    this.active = { sessionId, callSid, userId };
    this.reason = null;
  }

  /**
   * End `sessionId` if it is the current call. Returns false when it is not —
   * a socket dying for a call that was already replaced must not clear its
   * replacement. `userId` is matched too: Twilio `callSid`s (today's session
   * ids) are globally unique, so this is theoretical, but session ids are in
   * principle chosen by the caller of this method, not guaranteed unique
   * across users on their own.
   */
  end(sessionId: string, userId: string, reason: CallEndReason): boolean {
    if (this.active?.sessionId !== sessionId || this.active?.userId !== userId) return false;
    this.active = null;
    this.reason = reason;
    return true;
  }

  current(): ActiveCall | null {
    return this.active;
  }

  /** How the most recent call ended, or null if one is live or none has run. */
  lastReason(): CallEndReason | null {
    return this.reason;
  }
}
