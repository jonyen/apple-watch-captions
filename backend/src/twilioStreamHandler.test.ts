// backend/src/twilioStreamHandler.test.ts
import { describe, it, expect } from "vitest";
import { handleTwilioStream, TwilioSocketLike } from "./twilioStreamHandler";
import { SessionStore } from "./sessionStore";
import { CurrentCall } from "./currentCall";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";
import { ProviderOptions } from "./providerOptions";

/** A socket the test drives directly, standing in for Twilio. */
class FakeSocket implements TwilioSocketLike {
  private handlers = new Map<string, (...args: any[]) => void>();
  on(event: string, cb: (...args: any[]) => void) {
    this.handlers.set(event, cb);
    return this;
  }
  send(frame: object) {
    this.handlers.get("message")?.(Buffer.from(JSON.stringify(frame)));
  }
  close() {
    this.handlers.get("close")?.();
  }
}

function harness() {
  const providers: FakeTranscriptionProvider[] = [];
  const seen: (ProviderOptions | undefined)[] = [];
  const store = new SessionStore({
    createProvider: (opts) => {
      seen.push(opts);
      const p = new FakeTranscriptionProvider();
      providers.push(p);
      return p;
    },
  });
  const calls = new CurrentCall();
  const ws = new FakeSocket();
  handleTwilioStream(ws, store, calls);
  return { ws, store, calls, providers, seen };
}

const startFrame = (callSid: string) => ({
  event: "start",
  streamSid: `MZ-${callSid}`,
  start: { callSid, streamSid: `MZ-${callSid}` },
});

const mediaFrame = (payload: string) => ({
  event: "media",
  media: { track: "inbound", chunk: "1", timestamp: "5", payload },
});

describe("handleTwilioStream", () => {
  it("begins a telephony session on the start frame", () => {
    const { ws, calls, seen } = harness();

    ws.send(startFrame("CA1"));

    expect(calls.current()).toEqual({ sessionId: "CA1", callSid: "CA1" });
    expect(seen).toEqual([{ telephony: true }]);
  });

  it("feeds decoded audio to the session", () => {
    const { ws, providers } = harness();
    ws.send(startFrame("CA1"));

    ws.send(mediaFrame("AAECAw=="));

    expect(providers[0].receivedAudio.map((c) => [...c])).toEqual([[0, 1, 2, 3]]);
  });

  it("drops audio arriving before the start frame", () => {
    const { ws, providers } = harness();

    ws.send(mediaFrame("AAECAw=="));

    expect(providers).toHaveLength(0);
  });

  it("ends the call on the stop frame", () => {
    const { ws, calls, providers } = harness();
    ws.send(startFrame("CA1"));

    ws.send({ event: "stop" });

    expect(calls.current()).toBeNull();
    expect(calls.lastReason()).toBe("ended");
    expect(providers[0].closed).toBe(true);
  });

  // A socket that dies under a live call is not the call ending, and saying so
  // would be a lie on the user's wrist.
  it("reports a socket that closes without a stop frame as lost", () => {
    const { ws, calls, providers } = harness();
    ws.send(startFrame("CA1"));

    ws.close();

    expect(calls.lastReason()).toBe("stream_lost");
    expect(providers[0].closed).toBe(true);
  });

  it("does not report an end twice", () => {
    const { ws, calls } = harness();
    ws.send(startFrame("CA1"));
    ws.send({ event: "stop" });

    ws.close();

    expect(calls.lastReason()).toBe("ended");
  });

  it("survives a frame it cannot parse", () => {
    const { ws, calls } = harness();
    ws.send(startFrame("CA1"));

    ws.send({ event: "dtmf", dtmf: { digit: "1" } });

    expect(calls.current()).toEqual({ sessionId: "CA1", callSid: "CA1" });
  });
});
