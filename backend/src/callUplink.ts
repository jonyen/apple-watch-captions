/**
 * Where each user's voice goes, and the only handle on their call itself. The
 * HTTP routes that receive audio from the watch and the WebSocket that
 * carries it to Twilio never meet directly; the live call attaches its sender
 * here and the routes write through it.
 *
 * The socket closer is attached alongside, because under `<Connect><Stream>`
 * the call lives exactly as long as that WebSocket: closing it *is* the
 * hangup, and the watch is not a party to the socket. Without a closer
 * registered here, nothing on the watch — or in a replacement call — could
 * end a call at all.
 *
 * Keyed by `userId`, following `CurrentCall`'s pattern. This handle is the
 * most dangerous of the three call maps: with a single process-wide slot,
 * any self-registered device could speak into a stranger's live call
 * (`write`) or hang it up (`end`) — the same single-global-slot attack
 * `CurrentCall`'s doc comment names for the captions half. Keying by user
 * makes it impossible by construction: a route can only ever reach the entry
 * of the principal its own token resolved to.
 *
 * One call is captioned at a time **per user**, so a later attach for the
 * same user replaces their earlier one outright — audio must never reach a
 * socket a newer call has replaced. Entries are removed on detach/end (there
 * is no cross-call state to preserve here, unlike `CallAudioBuffer`'s `seq`).
 */
export class CallUplink {
  private readonly calls = new Map<
    string,
    { sender: (mulaw: Buffer) => void; closer: () => void }
  >();

  /**
   * Take ownership of `userId`'s live call. `close` must close the Twilio
   * socket; it is what `end()` calls, and it is kept paired with `sender` so
   * the two can never disagree about which call is current.
   */
  attach(userId: string, sender: (mulaw: Buffer) => void, close: () => void): void {
    this.calls.set(userId, { sender, closer: close });
  }

  /**
   * Detach the sender only if it is the one currently attached for `userId`.
   * Returns false when the given sender is no longer the active one — a socket
   * dying for a call that was already replaced must not clear its replacement.
   */
  detach(userId: string, sender: (mulaw: Buffer) => void): boolean {
    if (this.calls.get(userId)?.sender !== sender) return false;
    this.calls.delete(userId);
    return true;
  }

  /**
   * Hang up `userId`'s call: close its socket. Returns false when they have
   * no live call, so a route can answer 409 rather than pretend it ended
   * something.
   *
   * Cleared before the closer runs, so the close event the closer triggers
   * finds nothing left to detach and cannot race a call attached in between.
   */
  end(userId: string): boolean {
    const call = this.calls.get(userId);
    if (!call) return false;
    this.calls.delete(userId);
    call.closer();
    return true;
  }

  /** False when `userId` has no live call, so a caller can answer 409 rather than 200. */
  write(userId: string, mulaw: Buffer): boolean {
    const call = this.calls.get(userId);
    if (!call) return false;
    call.sender(mulaw);
    return true;
  }
}
