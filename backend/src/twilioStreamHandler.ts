import { SessionStore } from "./sessionStore";
import { CurrentCall, CallEndReason } from "./currentCall";
import { parseTwilioFrame } from "./twilioFrames";
import { CallAudioBuffer } from "./callAudioBuffer";
import { CallUplink } from "./callUplink";

/** Subset of a WebSocket this handler needs (keeps it testable). */
export interface TwilioSocketLike {
  on(event: string, cb: (...args: any[]) => void): unknown;
  send(data: string): void;
  /**
   * Close the stream. Under `<Connect><Stream>` this ends the call itself, so
   * it is the hangup path — see `CallUplink`.
   */
  close(): void;
}

/** Call sessions are always ephemeral and always telephony audio. */
const CALL_SESSION = { ephemeral: true, provider: { telephony: true } } as const;

export interface TwilioStreamOptions {
  /**
   * Whether this stream is the `<Connect><Stream>` shape: audio both ways, and
   * the call's lifetime tied to the socket. False for the fallback shape
   * (`<Start><Stream>` + `<Dial>`), which Twilio serves at the same endpoint
   * but which is strictly unidirectional — an outbound media frame there is at
   * best discarded and at worst a stream error that would cost the captions
   * the fallback exists to preserve. A one-way stream therefore attaches no
   * uplink (so speaking is refused with a 409 rather than silently dropped)
   * and fills no downlink (so the watch never plays a call the user is holding
   * on their phone, two seconds late, into the room).
   */
  twoWay?: boolean;
}

/**
 * Drive one Twilio Media Stream: begin a session on `start`, feed it audio,
 * and end it on `stop` or on the socket dying. On a two-way stream it also
 * carries audio the other way: the caller's audio is mirrored into `downlink`
 * for the watch to poll, whatever the watch sends is written back to Twilio
 * through `uplink`, and `uplink` holds the socket closer that ends the call.
 *
 * The Twilio `callSid` is the session id, so a call is traceable end to end
 * from the Twilio console into the relay's logs.
 */
export function handleTwilioStream(
  ws: TwilioSocketLike,
  store: SessionStore,
  calls: CurrentCall,
  downlink: CallAudioBuffer,
  uplink: CallUplink,
  options: TwilioStreamOptions = {},
): void {
  const twoWay = options.twoWay ?? true;
  let sessionId: string | null = null;
  // Every outbound frame must name the stream, so this is retained from the
  // start frame rather than discarded as it was in phase 1.
  let streamSid: string | null = null;
  // Kept so `detach` can confirm this is still the sender it attached — a
  // stale socket's teardown must not clear a newer call's uplink sender.
  let uplinkSender: ((mulaw: Buffer) => void) | null = null;
  // Set when the close about to arrive is one we asked for (the watch hung up,
  // or a newer call displaced this one) rather than the stream dying under a
  // live call. Only the latter is `stream_lost`, and telling the two apart is
  // the difference between "Call ended" and "Captions stopped" on the wrist.
  let hangingUp = false;

  const endCall = (reason: CallEndReason) => {
    if (!sessionId) return;
    const ending = sessionId;
    sessionId = null;
    streamSid = null;
    if (uplinkSender) {
      uplink.detach(uplinkSender);
      uplinkSender = null;
    }
    // `calls.end` only decides whether CurrentCall is cleared — a newer call
    // may already have replaced it, in which case it returns false.
    const wasCurrent = calls.end(ending, hangingUp ? "ended" : reason);
    // Identity-checked through exactly that answer. The buffer is shared
    // across calls, so a replaced handler's late teardown clearing it
    // unconditionally would delete the *live* call's undrained audio — and
    // since `clear()` deliberately leaves `seq` alone, the watch would see no
    // gap at all, just the caller's speech silently missing between polls.
    if (wasCurrent) downlink.clear();
    // But `store.stop` must run unconditionally: this handler's session may
    // have been recreated (e.g. by a stray `media` frame after replacement)
    // and still needs closing even though CurrentCall has moved on.
    store.stop(ending);
  };

  ws.on("message", (data: Buffer) => {
    const frame = parseTwilioFrame(data.toString("utf8"));
    switch (frame.type) {
      case "start": {
        // Newest call wins. Close the old one first so CurrentCall never holds
        // a session SessionStore has already dropped.
        const previous = calls.current();
        if (previous) {
          calls.end(previous.sessionId, "ended");
          store.stop(previous.sessionId);
          // And close the displaced call's socket. Under `<Connect><Stream>`
          // that socket *is* the call: leave it open and the earlier caller
          // sits on a live, billed call whose audio goes nowhere.
          uplink.end();
          // The previous call's own handler may never run its endCall (its
          // socket can outlive the replacement) — its buffered audio must not
          // be served to the watch under the new call's identity.
          downlink.clear();
        }
        sessionId = frame.callSid;
        streamSid = frame.streamSid;
        calls.begin(sessionId, frame.callSid, twoWay);
        // Empty feed creates the session and opens the upstream connection, so
        // transcription is warming up before the first audio arrives.
        store.feed(sessionId, Buffer.alloc(0), CALL_SESSION.ephemeral, CALL_SESSION.provider);

        // A one-way stream attaches nothing: Twilio cannot accept media back
        // on it, and there is no socket to close on the watch's behalf either,
        // since the phone — not this stream — holds that call.
        if (twoWay) {
          const sid = streamSid;
          uplinkSender = (mulaw) => {
            ws.send(JSON.stringify({
              event: "media",
              streamSid: sid,
              media: { payload: mulaw.toString("base64") },
            }));
          };
          uplink.attach(uplinkSender, () => {
            hangingUp = true;
            ws.close();
          });
        }
        break;
      }
      case "media":
        // Gate on this call still being current. A replaced call's handler
        // keeps its old `sessionId` in closure; without this guard, a media
        // frame arriving after replacement would call `store.feed` with a
        // session id `store.stop` already removed, recreating it — and
        // opening a fresh, unreachable Deepgram connection — under a session
        // id nobody polls anymore.
        if (sessionId && calls.current()?.sessionId === sessionId) {
          store.feed(sessionId, frame.audio, CALL_SESSION.ephemeral, CALL_SESSION.provider);
          // The same bytes, untranscoded, for the watch to play — but only on
          // a call the watch is actually holding.
          if (twoWay) downlink.append(frame.audio);
        }
        break;
      case "stop":
        endCall("ended");
        break;
      default:
        break;
    }
  });

  ws.on("close", () => endCall("stream_lost"));
  ws.on("error", () => endCall("stream_lost"));
}
