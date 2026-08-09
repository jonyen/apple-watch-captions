/**
 * Where your voice goes, and the only handle on the call itself. The HTTP
 * routes that receive audio from the watch and the WebSocket that carries it to
 * Twilio never meet directly; the live call attaches its sender here and the
 * routes write through it.
 *
 * The socket closer is attached alongside, because under `<Connect><Stream>`
 * the call lives exactly as long as that WebSocket: closing it *is* the hangup,
 * and the watch is not a party to the socket. Without a closer registered here,
 * nothing on the watch — or in a replacement call — could end a call at all.
 *
 * Only one call is captioned at a time, so a later attach replaces the earlier
 * one outright — audio must never reach a socket a newer call has replaced.
 */
export class CallUplink {
  private sender: ((mulaw: Buffer) => void) | null = null;
  private closer: (() => void) | null = null;

  /**
   * Take ownership of the live call. `close` must close the Twilio socket;
   * it is what `end()` calls, and it is kept paired with `sender` so the two
   * can never disagree about which call is current.
   */
  attach(sender: (mulaw: Buffer) => void, close: () => void): void {
    this.sender = sender;
    this.closer = close;
  }

  /**
   * Detach the sender only if it is the currently attached one.
   * Returns false when the given sender is no longer the active one — a socket
   * dying for a call that was already replaced must not clear its replacement.
   */
  detach(sender: (mulaw: Buffer) => void): boolean {
    if (this.sender !== sender) return false;
    this.sender = null;
    this.closer = null;
    return true;
  }

  /**
   * Hang up: close the live call's socket. Returns false when no call is live,
   * so a route can answer 409 rather than pretend it ended something.
   *
   * Cleared before the closer runs, so the close event the closer triggers
   * finds nothing left to detach and cannot race a call attached in between.
   */
  end(): boolean {
    const closer = this.closer;
    if (!closer) return false;
    this.sender = null;
    this.closer = null;
    closer();
    return true;
  }

  /** False when no call is live, so a caller can answer 409 rather than 200. */
  write(mulaw: Buffer): boolean {
    if (!this.sender) return false;
    this.sender(mulaw);
    return true;
  }
}
