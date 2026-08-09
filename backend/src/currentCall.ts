
export type CallEndReason = "ended" | "stream_lost";

export interface ActiveCall {
  /** The SessionStore session carrying this call's captions. */
  sessionId: string;
  callSid: string;
  /**
   * True when the watch holds this call: `<Connect><Stream>`, audio both ways,
   * hangup by closing the socket. False on the fallback shape
   * (`<Start><Stream>` + `<Dial>`), which is captions only — the phone holds
   * that call, the stream is unidirectional, and neither speaking nor hanging
   * up from the watch is possible.
   */
  twoWay: boolean;
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

  begin(sessionId: string, callSid: string, twoWay = true): void {
    this.active = { sessionId, callSid, twoWay };
    this.reason = null;
  }

  /**
   * End `sessionId` if it is the current call. Returns false when it is not —
   * a socket dying for a call that was already replaced must not clear its
   * replacement.
   */
  end(sessionId: string, reason: CallEndReason): boolean {
    if (this.active?.sessionId !== sessionId) return false;
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
