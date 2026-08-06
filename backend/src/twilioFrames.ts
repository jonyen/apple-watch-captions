// backend/src/twilioFrames.ts

/** One decoded frame from a Twilio Media Stream WebSocket. */
export type TwilioFrame =
  | { type: "connected" }
  | { type: "start"; callSid: string; streamSid: string }
  | { type: "media"; audio: Buffer }
  | { type: "stop" }
  /** Understood but uninteresting, or unparseable. Never an error. */
  | { type: "ignored" };

/**
 * Decode one raw frame. Anything malformed, unknown, or missing the fields we
 * depend on reads as `ignored` — a single bad frame must not end a live call.
 */
export function parseTwilioFrame(raw: string): TwilioFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { type: "ignored" };
  }
  if (typeof parsed !== "object" || parsed === null) return { type: "ignored" };
  const frame = parsed as Record<string, any>;

  switch (frame.event) {
    case "connected":
      return { type: "connected" };
    case "start": {
      const callSid = frame.start?.callSid;
      const streamSid = frame.start?.streamSid ?? frame.streamSid;
      if (typeof callSid !== "string" || typeof streamSid !== "string") {
        return { type: "ignored" };
      }
      return { type: "start", callSid, streamSid };
    }
    case "media": {
      const payload = frame.media?.payload;
      if (typeof payload !== "string") return { type: "ignored" };
      return { type: "media", audio: Buffer.from(payload, "base64") };
    }
    case "stop":
      return { type: "stop" };
    default:
      return { type: "ignored" };
  }
}
