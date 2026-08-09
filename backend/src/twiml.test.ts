import { describe, it, expect } from "vitest";
import { voiceResponse, ringbackResponse, connectStreamResponse } from "./twiml";

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

  // Without a status callback a stream that never connects is invisible here:
  // Twilio files an alert carrying an error code and nothing else.
  it("asks Twilio to report the stream's fate when given a callback", () => {
    const xml = voiceResponse({
      streamUrl: "wss://relay.example/twilio/stream?token=abc",
      dialTo: "+15551234567",
      streamStatusUrl: "https://relay.example/twilio/stream-status?token=abc",
    });

    expect(xml).toContain(
      'statusCallback="https://relay.example/twilio/stream-status?token=abc"');
    expect(xml).toContain('statusCallbackMethod="POST"');
  });

  it("omits the callback attributes when no URL is given", () => {
    const xml = voiceResponse({
      streamUrl: "wss://relay.example/twilio/stream?token=abc",
      dialTo: "+15551234567",
    });

    expect(xml).not.toContain("statusCallback");
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

describe("ringbackResponse", () => {
  it("rings, then asks Twilio to check again", () => {
    const xml = ringbackResponse({
      ringbackUrl: "https://relay.example/twilio/ringback.wav",
      nextUrl: "https://relay.example/twilio/voice?token=abc&attempt=2",
    });

    expect(xml).toContain("<Play>https://relay.example/twilio/ringback.wav</Play>");
    expect(xml).toContain("&amp;attempt=2");
    expect(xml.indexOf("<Play>")).toBeLessThan(xml.indexOf("<Redirect>"));
  });
});

describe("connectStreamResponse", () => {
  // <Connect> is the blocking, bidirectional form: the call lives exactly as
  // long as the socket. <Start> would return immediately and end the call.
  it("connects a bidirectional stream", () => {
    const xml = connectStreamResponse({
      streamUrl: "wss://relay.example/twilio/stream/abc",
    });

    expect(xml).toContain("<Connect>");
    expect(xml).toContain('<Stream url="wss://relay.example/twilio/stream/abc"');
    expect(xml).not.toContain("<Start>");
    expect(xml).not.toContain("<Dial>");
  });

  it("carries a status callback when given one", () => {
    const xml = connectStreamResponse({
      streamUrl: "wss://relay.example/twilio/stream/abc",
      streamStatusUrl: "https://relay.example/twilio/stream-status?token=abc",
    });

    expect(xml).toContain('statusCallback="https://relay.example/twilio/stream-status?token=abc"');
  });

  // A bidirectional stream carries the caller's audio in both directions;
  // restricting the track would silence half of it.
  it("does not restrict the track", () => {
    expect(connectStreamResponse({ streamUrl: "wss://x/y" })).not.toContain("track=");
  });
});
