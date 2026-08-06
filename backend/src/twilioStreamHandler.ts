import { SessionStore } from "./sessionStore";
import { CurrentCall, CallEndReason } from "./currentCall";
import { parseTwilioFrame } from "./twilioFrames";

/** Subset of a WebSocket this handler needs (keeps it testable). */
export interface TwilioSocketLike {
  on(event: string, cb: (...args: any[]) => void): unknown;
}

/** Call sessions are always ephemeral and always telephony audio. */
const CALL_SESSION = { ephemeral: true, provider: { telephony: true } } as const;

/**
 * Drive one Twilio Media Stream: begin a session on `start`, feed it audio,
 * and end it on `stop` or on the socket dying.
 *
 * The Twilio `callSid` is the session id, so a call is traceable end to end
 * from the Twilio console into the relay's logs.
 */
export function handleTwilioStream(
  ws: TwilioSocketLike,
  store: SessionStore,
  calls: CurrentCall,
): void {
  let sessionId: string | null = null;

  const endCall = (reason: CallEndReason) => {
    if (!sessionId) return;
    const ending = sessionId;
    sessionId = null;
    // Only tear down the SessionStore side if this call was still the current
    // one; a newer call may already have replaced it.
    if (calls.end(ending, reason)) store.stop(ending);
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
        calls.begin(sessionId, frame.callSid);
        // Empty feed creates the session and opens the upstream connection, so
        // transcription is warming up before the first audio arrives.
        store.feed(sessionId, Buffer.alloc(0), CALL_SESSION.ephemeral, CALL_SESSION.provider);
        break;
      }
      case "media":
        if (sessionId) {
          store.feed(sessionId, frame.audio, CALL_SESSION.ephemeral, CALL_SESSION.provider);
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
