/**
 * Where your voice goes. The HTTP route that receives audio from the watch and
 * the WebSocket that carries it to Twilio never meet directly; the live call
 * attaches its sender here and the route writes through it.
 *
 * Only one call is captioned at a time, so a later attach replaces the earlier
 * one outright — audio must never reach a socket a newer call has replaced.
 */
export class CallUplink {
  private sender: ((mulaw: Buffer) => void) | null = null;

  attach(sender: (mulaw: Buffer) => void): void {
    this.sender = sender;
  }

  /**
   * Detach the sender only if it is the currently attached one.
   * Returns false when the given sender is no longer the active one — a socket
   * dying for a call that was already replaced must not clear its replacement.
   */
  detach(sender: (mulaw: Buffer) => void): boolean {
    if (this.sender !== sender) return false;
    this.sender = null;
    return true;
  }

  /** False when no call is live, so a caller can answer 409 rather than 200. */
  write(mulaw: Buffer): boolean {
    if (!this.sender) return false;
    this.sender(mulaw);
    return true;
  }
}
