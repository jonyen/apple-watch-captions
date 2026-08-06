import { describe, it, expect } from "vitest";
import { voiceResponse } from "./twiml";

describe("voiceResponse", () => {
  it("forks the caller's audio and then dials through", () => {
    const xml = voiceResponse({
      streamUrl: "wss://relay.example/twilio/stream?token=abc",
      dialTo: "+15551234567",
    });

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<Stream url="wss://relay.example/twilio/stream?token=abc"');
    // inbound_track is the caller. Forking both would caption the user too.
    expect(xml).toContain('track="inbound_track"');
    expect(xml).toContain("<Dial>+15551234567</Dial>");
    // <Start> is the non-blocking form, so <Dial> still runs.
    expect(xml.indexOf("<Start>")).toBeLessThan(xml.indexOf("<Dial>"));
  });

  // A token with an ampersand would otherwise produce XML Twilio cannot parse,
  // and the call would fail with no obvious cause.
  it("escapes XML metacharacters in the stream URL", () => {
    const xml = voiceResponse({
      streamUrl: "wss://relay.example/twilio/stream?token=a&b<c",
      dialTo: "+15551234567",
    });

    expect(xml).toContain("token=a&amp;b&lt;c");
    expect(xml).not.toContain("token=a&b");
  });
});
