// backend/src/twilioFrames.test.ts
import { describe, it, expect } from "vitest";
import { parseTwilioFrame } from "./twilioFrames";

describe("parseTwilioFrame", () => {
  it("reads the handshake", () => {
    expect(parseTwilioFrame(JSON.stringify({ event: "connected", protocol: "Call" })))
      .toEqual({ type: "connected" });
  });

  it("reads the call and stream ids off the start frame", () => {
    const raw = JSON.stringify({
      event: "start",
      streamSid: "MZ123",
      start: { callSid: "CA456", streamSid: "MZ123", tracks: ["inbound"] },
    });

    expect(parseTwilioFrame(raw)).toEqual({
      type: "start",
      callSid: "CA456",
      streamSid: "MZ123",
    });
  });

  it("base64-decodes media payloads", () => {
    const raw = JSON.stringify({
      event: "media",
      streamSid: "MZ123",
      media: { track: "inbound", chunk: "1", timestamp: "5", payload: "AAECAw==" },
    });

    const frame = parseTwilioFrame(raw);

    expect(frame.type).toBe("media");
    expect(frame.type === "media" && [...frame.audio]).toEqual([0, 1, 2, 3]);
  });

  it("reads the stop frame", () => {
    expect(parseTwilioFrame(JSON.stringify({ event: "stop", streamSid: "MZ123" })))
      .toEqual({ type: "stop" });
  });

  // A live call must survive a frame it does not understand. Every one of these
  // is "nothing happened", never a throw.
  it("ignores frames it cannot use rather than throwing", () => {
    expect(parseTwilioFrame("not json")).toEqual({ type: "ignored" });
    expect(parseTwilioFrame("null")).toEqual({ type: "ignored" });
    expect(parseTwilioFrame(JSON.stringify({ event: "dtmf", dtmf: { digit: "1" } })))
      .toEqual({ type: "ignored" });
    expect(parseTwilioFrame(JSON.stringify({ event: "mark" }))).toEqual({ type: "ignored" });
    expect(parseTwilioFrame(JSON.stringify({ event: "start", start: {} })))
      .toEqual({ type: "ignored" });
    expect(parseTwilioFrame(JSON.stringify({ event: "media", media: {} })))
      .toEqual({ type: "ignored" });
  });
});
