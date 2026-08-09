import { SessionStore } from "./sessionStore";
import { CurrentCall, CallEndReason } from "./currentCall";
import { parseTwilioFrame } from "./twilioFrames";
import { CallAudioBuffer } from "./callAudioBuffer";
import { CallUplink } from "./callUplink";

/** Subset of a WebSocket this handler needs (keeps it testable). */
export interface TwilioSocketLike {
  on(event: string, cb: (...args: any[]) => void): unknown;
  send(data: string): void;
}

/** Call sessions are always ephemeral and always telephony audio. */
const CALL_SESSION = { ephemeral: true, provider: { telephony: true } } as const;

/**
 * Drive one Twilio Media Stream: begin a session on `start`, feed it audio,
 * and end it on `stop` or on the socket dying. Also carries audio the other
 * way: the caller's audio is mirrored into `downlink` for the watch to poll,
 * and whatever the watch sends is written back to Twilio through `uplink`.
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
): void {
  let sessionId: string | null = null;
  // Every outbound frame must name the stream, so this is retained from the
  // start frame rather than discarded as it was in phase 1.
  let streamSid: string | null = null;
  // Kept so `detach` can confirm this is still the sender it attached — a
  // stale socket's teardown must not clear a newer call's uplink sender.
  let uplinkSender: ((mulaw: Buffer) => void) | null = null;

  const endCall = (reason: CallEndReason) => {
    if (!sessionId) return;
    const ending = sessionId;
    sessionId = null;
    streamSid = null;
    if (uplinkSender) {
      uplink.detach(uplinkSender);
      uplinkSender = null;
    }
    // The next call must not inherit this one's audio.
    downlink.clear();
    // `calls.end` only decides whether CurrentCall is cleared — a newer call
    // may already have replaced it, in which case it returns false. But
    // `store.stop` must run unconditionally: this handler's session may have
    // been recreated (e.g. by a stray `media` frame after replacement) and
    // still needs closing even though CurrentCall has moved on.
    calls.end(ending, reason);
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
        }
        sessionId = frame.callSid;
        streamSid = frame.streamSid;
        calls.begin(sessionId, frame.callSid);
        // Empty feed creates the session and opens the upstream connection, so
        // transcription is warming up before the first audio arrives.
        store.feed(sessionId, Buffer.alloc(0), CALL_SESSION.ephemeral, CALL_SESSION.provider);

        const sid = streamSid;
        uplinkSender = (mulaw) => {
          ws.send(JSON.stringify({
            event: "media",
            streamSid: sid,
            media: { payload: mulaw.toString("base64") },
          }));
        };
        uplink.attach(uplinkSender);
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
          // The same bytes, untranscoded, for the watch to play.
          downlink.append(frame.audio);
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
