// backend/src/twilioStreamHandler.test.ts
import { describe, it, expect } from "vitest";
import { handleTwilioStream, TwilioSocketLike } from "./twilioStreamHandler";
import { SessionStore } from "./sessionStore";
import { CurrentCall } from "./currentCall";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";
import { ProviderOptions } from "./providerOptions";
import { CallAudioBuffer } from "./callAudioBuffer";
import { CallUplink } from "./callUplink";

/**
 * A socket the test drives directly, standing in for Twilio. `send` is the
 * production `TwilioSocketLike` method — the handler under test calls it
 * with a JSON string to send audio out, and `sent` records exactly that.
 * `receive` is test-only: it simulates Twilio pushing a frame in. Keeping
 * these as two distinctly named methods (rather than one overloaded on
 * argument type) means a call written the way real code would call `send` —
 * `ws.send(JSON.stringify(frame))` — cannot be silently swallowed into
 * `sent` when it was meant to drive the handler; it just does what `send`
 * actually does.
 */
class FakeSocket implements TwilioSocketLike {
  private handlers = new Map<string, (...args: any[]) => void>();
  sent: string[] = [];
  on(event: string, cb: (...args: any[]) => void) {
    this.handlers.set(event, cb);
    return this;
  }
  send(data: string) {
    this.sent.push(data);
  }
  /** Simulates Twilio pushing a frame in over the socket. */
  receive(frame: object) {
    this.handlers.get("message")?.(Buffer.from(JSON.stringify(frame)));
  }
  /**
   * The production `TwilioSocketLike.close` — the handler calls it to hang up.
   * Deliberately does *not* fire the close handler: a real socket closes
   * asynchronously, so the `close` event lands on a later tick, after
   * whatever else was already in flight. Collapsing the two would hide every
   * ordering bug that lives in that gap. `die()` delivers the event.
   */
  close() {
    this.closes += 1;
  }
  /** How many times the handler asked to close this socket. */
  closes = 0;
  /** Simulates the socket's close event arriving. */
  die() {
    this.handlers.get("close")?.();
  }
}

function harness(options: { twoWay?: boolean } = {}) {
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
  const downlink = new CallAudioBuffer();
  const uplink = new CallUplink();
  handleTwilioStream(ws, store, calls, downlink, uplink, options);
  return { ws, store, calls, providers, seen, downlink, uplink };
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

    ws.receive(startFrame("CA1"));

    expect(calls.current()).toEqual({ sessionId: "CA1", callSid: "CA1", twoWay: true });
    expect(seen).toEqual([{ telephony: true }]);
  });

  it("feeds decoded audio to the session", () => {
    const { ws, providers } = harness();
    ws.receive(startFrame("CA1"));

    ws.receive(mediaFrame("AAECAw=="));

    expect(providers[0].receivedAudio.map((c) => [...c])).toEqual([[0, 1, 2, 3]]);
  });

  it("drops audio arriving before the start frame", () => {
    const { ws, providers } = harness();

    ws.receive(mediaFrame("AAECAw=="));

    expect(providers).toHaveLength(0);
  });

  it("ends the call on the stop frame", () => {
    const { ws, calls, providers } = harness();
    ws.receive(startFrame("CA1"));

    ws.receive({ event: "stop" });

    expect(calls.current()).toBeNull();
    expect(calls.lastReason()).toBe("ended");
    expect(providers[0].closed).toBe(true);
  });

  // A socket that dies under a live call is not the call ending, and saying so
  // would be a lie on the user's wrist.
  it("reports a socket that closes without a stop frame as lost", () => {
    const { ws, calls, providers } = harness();
    ws.receive(startFrame("CA1"));

    ws.die();

    expect(calls.lastReason()).toBe("stream_lost");
    expect(providers[0].closed).toBe(true);
  });

  it("does not report an end twice", () => {
    const { ws, calls } = harness();
    ws.receive(startFrame("CA1"));
    ws.receive({ event: "stop" });

    ws.die();

    expect(calls.lastReason()).toBe("ended");
  });

  it("survives a frame it cannot parse", () => {
    const { ws, calls } = harness();
    ws.receive(startFrame("CA1"));

    ws.receive({ event: "dtmf", dtmf: { digit: "1" } });

    expect(calls.current()).toEqual({ sessionId: "CA1", callSid: "CA1", twoWay: true });
  });

  // A replaced call is driven by a *second* socket/handler, so its old
  // handler's closure still holds the replaced sessionId. Without the
  // current-call guard on `media`, that stale handler would resurrect the
  // replaced session and open a third, unreachable provider; without an
  // unconditional `store.stop` in `endCall`, that resurrected session's
  // provider would then never close.
  it("does not resurrect a replaced call's session or leak its provider", () => {
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
    const wsA = new FakeSocket();
    const wsB = new FakeSocket();
    handleTwilioStream(wsA, store, calls, new CallAudioBuffer(), new CallUplink());
    handleTwilioStream(wsB, store, calls, new CallAudioBuffer(), new CallUplink());

    wsA.receive(startFrame("CA1"));
    wsB.receive(startFrame("CA2"));
    // CA2's start already ended CA1 and stopped its provider.
    expect(providers).toHaveLength(2);
    expect(providers[0].closed).toBe(true);

    // A media frame arriving late on the replaced socket (A still holds
    // sessionId "CA1" in its closure) must not recreate CA1's session.
    wsA.receive(mediaFrame("AAECAw=="));
    expect(providers).toHaveLength(2);

    // A's socket closing without ever having been the current call must not
    // leak anything — no third provider, and CA2 is untouched.
    wsA.die();
    expect(providers).toHaveLength(2);
    expect(calls.current()).toEqual({ sessionId: "CA2", callSid: "CA2", twoWay: true });

    // CA2 is still genuinely live and ends normally, closing its provider —
    // confirming the fix did not also break the happy path.
    wsB.die();

    expect(providers).toHaveLength(2);
    expect(providers.every((p) => p.closed)).toBe(true);
  });
});

describe("bidirectional audio", () => {
  it("copies the caller's audio into the downlink buffer", () => {
    const { ws, downlink } = harness();
    ws.receive(startFrame("CA1"));

    ws.receive(mediaFrame("AAECAw=="));

    expect([...downlink.drain(0).audio]).toEqual([0, 1, 2, 3]);
  });

  // streamSid is required on every outbound frame. The handler previously kept
  // only callSid, and the uplink cannot work without it.
  it("sends uplink audio back to Twilio addressed to the stream", () => {
    const { ws, uplink } = harness();
    ws.receive(startFrame("CA1"));

    expect(uplink.write(Buffer.from([0xff, 0xff]))).toBe(true);

    const frame = JSON.parse(ws.sent.at(-1)!);
    expect(frame.event).toBe("media");
    expect(frame.streamSid).toBe("MZ-CA1");
    expect(Buffer.from(frame.media.payload, "base64").length).toBe(2);
  });

  it("stops accepting uplink audio once the call ends", () => {
    const { ws, uplink } = harness();
    ws.receive(startFrame("CA1"));
    ws.receive({ event: "stop" });

    expect(uplink.write(Buffer.from([0xff]))).toBe(false);
  });

  it("empties the downlink buffer when a call ends, so the next call starts clean", () => {
    const { ws, downlink } = harness();
    ws.receive(startFrame("CA1"));
    ws.receive(mediaFrame("AAECAw=="));

    ws.receive({ event: "stop" });

    expect(downlink.drain(0).audio.length).toBe(0);
  });

  // The whole reason detach() takes the sender rather than clearing
  // unconditionally: a socket dying for a call that was already replaced
  // must not silence the call that replaced it.
  it("does not let a stale socket's teardown silence a newer call's uplink", () => {
    const store = new SessionStore({ createProvider: () => new FakeTranscriptionProvider() });
    const calls = new CurrentCall();
    const downlink = new CallAudioBuffer();
    const uplink = new CallUplink();
    const wsA = new FakeSocket();
    const wsB = new FakeSocket();
    handleTwilioStream(wsA, store, calls, downlink, uplink);
    handleTwilioStream(wsB, store, calls, downlink, uplink);

    wsA.receive(startFrame("CA1"));
    wsB.receive(startFrame("CA2"));

    // Audio B has taken in but the watch has not collected yet. A's teardown
    // must leave it alone.
    wsB.receive(mediaFrame("AAECAw=="));

    // A's socket dying after being replaced must not silence B's live call.
    wsA.die();

    expect(uplink.write(Buffer.from([0xaa]))).toBe(true);
    const frame = JSON.parse(wsB.sent.at(-1)!);
    expect(frame.streamSid).toBe("MZ-CA2");

    // The downlink is the one shared object teardown used to wipe
    // unconditionally. Because `clear()` deliberately leaves `seq` alone, the
    // watch would have seen no gap — just the caller's speech silently
    // missing between two polls.
    expect([...downlink.drain(0).audio]).toEqual([0, 1, 2, 3]);
  });

  // The uplink survives a replacement because attach() unconditionally
  // overwrites, so the new sender wins immediately regardless of what the
  // old handler does. CallAudioBuffer has no such self-healing semantics —
  // it is an append-only shared queue, so A's buffered-but-undrained audio
  // would otherwise sit there and be served under B's identity until A's own
  // socket eventually tears down.
  it("does not let a replaced call's buffered audio leak into the new call's downlink", () => {
    const store = new SessionStore({ createProvider: () => new FakeTranscriptionProvider() });
    const calls = new CurrentCall();
    const downlink = new CallAudioBuffer();
    const uplink = new CallUplink();
    const wsA = new FakeSocket();
    const wsB = new FakeSocket();
    handleTwilioStream(wsA, store, calls, downlink, uplink);
    handleTwilioStream(wsB, store, calls, downlink, uplink);

    wsA.receive(startFrame("CA1"));
    wsA.receive(mediaFrame("AAECAw=="));

    wsB.receive(startFrame("CA2"));

    expect(downlink.drain(0).audio.length).toBe(0);
  });
});

describe("ending the call", () => {
  // The whole point of <Connect><Stream>: the call lives exactly as long as
  // this socket, so closing it is the hangup. Nothing else can end the call —
  // the watch is not a party to the socket at all.
  it("hangs up by closing the socket when the uplink is ended", () => {
    const { ws, uplink } = harness();
    ws.receive(startFrame("CA1"));

    expect(uplink.end()).toBe(true);

    expect(ws.closes).toBe(1);
  });

  // Twilio's close event follows the close we asked for. It must read as the
  // call ending, not as the stream dying under a live call — "Captions
  // stopped" would be the wrong thing to leave on the wrist after hanging up.
  it("reports a hangup as the call ending, not as a lost stream", () => {
    const { ws, calls, uplink } = harness();
    ws.receive(startFrame("CA1"));
    uplink.end();

    ws.die();

    expect(calls.current()).toBeNull();
    expect(calls.lastReason()).toBe("ended");
  });

  it("has nothing to hang up once the call is over", () => {
    const { ws, uplink } = harness();
    ws.receive(startFrame("CA1"));
    ws.receive({ event: "stop" });

    expect(uplink.end()).toBe(false);
  });

  // A displaced caller is stranded exactly as badly as one nobody hung up on:
  // their socket stays open, their call stays live and billed, and every byte
  // of their audio is discarded because a newer call owns the buffers.
  it("closes the displaced call's socket when a newer call replaces it", () => {
    const store = new SessionStore({ createProvider: () => new FakeTranscriptionProvider() });
    const calls = new CurrentCall();
    const downlink = new CallAudioBuffer();
    const uplink = new CallUplink();
    const wsA = new FakeSocket();
    const wsB = new FakeSocket();
    handleTwilioStream(wsA, store, calls, downlink, uplink);
    handleTwilioStream(wsB, store, calls, downlink, uplink);

    wsA.receive(startFrame("CA1"));
    wsB.receive(startFrame("CA2"));

    expect(wsA.closes).toBe(1);
    // And the replacement is untouched: it is the live call now.
    expect(wsB.closes).toBe(0);
    expect(uplink.write(Buffer.from([0xaa]))).toBe(true);
  });
});

// The fallback branch serves <Start><Stream> + <Dial> at this same endpoint.
// That stream is unidirectional: Twilio cannot accept media back on it, and a
// malformed outbound frame risks erroring the stream — losing the captions the
// fallback exists to preserve. The phone holds that call, so the watch must
// neither speak into it nor play the caller aloud two seconds late.
describe("a one-way (fallback) stream", () => {
  it("attaches no uplink, so speaking is refused rather than silently dropped", () => {
    const { ws, uplink } = harness({ twoWay: false });

    ws.receive(startFrame("CA1"));

    expect(uplink.write(Buffer.from([0xff]))).toBe(false);
    expect(ws.sent).toHaveLength(0);
  });

  it("fills no downlink, so the watch has nothing to play", () => {
    const { ws, downlink } = harness({ twoWay: false });
    ws.receive(startFrame("CA1"));

    ws.receive(mediaFrame("AAECAw=="));

    expect(downlink.drain(0).audio.length).toBe(0);
  });

  // Captions are the entire reason the fallback keeps a stream at all.
  it("still captions the call", () => {
    const { ws, providers, calls } = harness({ twoWay: false });
    ws.receive(startFrame("CA1"));

    ws.receive(mediaFrame("AAECAw=="));

    expect(calls.current()).toEqual({ sessionId: "CA1", callSid: "CA1", twoWay: false });
    expect(providers[0].receivedAudio.map((c) => [...c])).toEqual([[0, 1, 2, 3]]);
  });

  it("cannot be hung up from the watch, because the phone holds the call", () => {
    const { ws, uplink } = harness({ twoWay: false });
    ws.receive(startFrame("CA1"));

    expect(uplink.end()).toBe(false);
    expect(ws.closes).toBe(0);
  });
});
