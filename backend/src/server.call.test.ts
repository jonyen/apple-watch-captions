import { describe, it, expect, afterEach } from "vitest";
import { AddressInfo } from "net";
import WebSocket from "ws";
import { startServer, CaptionServer } from "./server";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";
import { pcm16kToMuLaw8k } from "./mulaw";

let running: CaptionServer | null = null;

afterEach(async () => {
  if (running) await running.close();
  running = null;
});

function start(
  callForwardTo?: string,
  authToken = "good",
  extra: { waitAttempts?: number } = {},
) {
  const providers: FakeTranscriptionProvider[] = [];
  const server = startServer({
    port: 0,
    authToken,
    createProvider: () => {
      const p = new FakeTranscriptionProvider();
      providers.push(p);
      return p;
    },
    callForwardTo,
    ...extra,
  });
  running = server;
  return { providers, port: (server.address() as AddressInfo).port };
}

const base = (port: number) => `http://127.0.0.1:${port}`;

describe("POST /twilio/voice", () => {
  // attempt=99 is past the wait budget, landing on the fallback branch —
  // phase 1's shape, still the one this test pins.
  it("returns TwiML pointing the stream at this relay", async () => {
    const { port } = start("+15551234567");

    const res = await fetch(`${base(port)}/twilio/voice?token=good&attempt=99`, { method: "POST" });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/xml");
    const xml = await res.text();
    // Token in the path: Twilio's stream client discards the query string.
    expect(xml).toContain(`wss://127.0.0.1:${port}/twilio/stream/good`);
    expect(xml).toContain('track="inbound_track"');
    expect(xml).toContain("<Dial>+15551234567</Dial>");
  });

  it("rejects a request without a valid token", async () => {
    const { port } = start("+15551234567");
    expect((await fetch(`${base(port)}/twilio/voice`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${base(port)}/twilio/voice?token=bad`, { method: "POST" })).status)
      .toBe(401);
  });

  // Better to refuse than to answer with TwiML that dials nowhere.
  it("503s when no forwarding number is configured", async () => {
    const { port } = start(undefined);
    const res = await fetch(`${base(port)}/twilio/voice?token=good`, { method: "POST" });
    expect(res.status).toBe(503);
  });
});

describe("GET /v1/call", () => {
  it("reports no call when none is live", async () => {
    const { port } = start("+15551234567");

    const res = await fetch(`${base(port)}/v1/call?token=good`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ active: false, events: [], seq: 0 });
  });

  it("rejects a poll without a valid token", async () => {
    const { port } = start("+15551234567");
    expect((await fetch(`${base(port)}/v1/call`)).status).toBe(401);
    expect((await fetch(`${base(port)}/v1/call?token=bad`)).status).toBe(401);
  });

  // Twilio's media-stream client discards the query string — a live call
  // reached the relay as a bare `/twilio/stream` with no token, so the relay
  // rejected it and Twilio reported "server closed the connection". The token
  // travels in the path because that is what actually survives.
  it("accepts a stream whose token is in the path, as Twilio sends it", async () => {
    const { providers, port } = start("+15551234567");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/twilio/stream/good`);
    await new Promise((resolve) => ws.on("open", resolve));

    ws.send(JSON.stringify({
      event: "start",
      streamSid: "MZpath",
      start: { callSid: "CApath", streamSid: "MZpath" },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    providers[0].emitReady();

    const body = await (await fetch(`${base(port)}/v1/call?token=good`)).json();

    expect(body.active).toBe(true);
    ws.close();
  });

  it("rejects a stream whose path token is wrong", async () => {
    const { port } = start("+15551234567");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/twilio/stream/nope`);
    const code = await new Promise((resolve) => ws.on("close", resolve));

    expect(code).toBe(4001);
  });

  it("serves captions from the live call", async () => {
    const { providers, port } = start("+15551234567");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/twilio/stream?token=good`);
    await new Promise((resolve) => ws.on("open", resolve));

    ws.send(JSON.stringify({
      event: "start",
      streamSid: "MZ1",
      start: { callSid: "CA1", streamSid: "MZ1" },
    }));
    // Give the server a tick to process the frame and create the session.
    await new Promise((resolve) => setTimeout(resolve, 50));
    providers[0].emitReady();
    providers[0].emitTranscript({ text: "hello there", isFinal: true });

    const body = await (await fetch(`${base(port)}/v1/call?token=good`)).json();

    expect(body.active).toBe(true);
    expect(body.events.some((e: any) => e.type === "caption" && e.text === "hello there"))
      .toBe(true);
    ws.close();
  });

  // reapIdle (and a direct /v1/stop) can drop the SessionStore session
  // without telling CurrentCall. Without the guard in GET /v1/call, this
  // would report `active: true` forever with no captions ever arriving —
  // simulate it here by stopping the session out from under CurrentCall and
  // confirming the endpoint notices instead of hanging.
  it("reports no call when its session has been reaped out from under CurrentCall", async () => {
    const { port } = start("+15551234567");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/twilio/stream?token=good`);
    await new Promise((resolve) => ws.on("open", resolve));

    ws.send(JSON.stringify({
      event: "start",
      streamSid: "MZ1",
      start: { callSid: "CA1", streamSid: "MZ1" },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Drop the session directly, bypassing the normal end-of-call path so
    // CurrentCall still believes CA1 is live.
    await fetch(`${base(port)}/v1/stop?token=good&session=CA1`, { method: "POST" });

    const body = await (await fetch(`${base(port)}/v1/call?token=good`)).json();
    // The call itself may still be live — only its captions died — so this
    // is stream_lost, not ended. Reporting "ended" would tell the watch the
    // call is over while the user may still be talking.
    expect(body).toEqual({ active: false, reason: "stream_lost", events: [], seq: 0 });
    ws.close();
  });
});

describe("POST /twilio/voice with a token containing XML metacharacters", () => {
  // escapeXml(streamUrl) in twiml.ts is dead code on this path — the query
  // string is already encodeURIComponent'd before voiceResponse ever sees
  // it, so the safety here rests entirely on that encode surviving future
  // edits. Pin the whole composition at the route, not just the XML half in
  // isolation (that's twiml.test.ts).
  it("keeps the emitted TwiML well-formed", async () => {
    const token = 'a&b<c>d"e';
    const { port } = start("+15551234567", token);

    const res = await fetch(
      `${base(port)}/twilio/voice?token=${encodeURIComponent(token)}&attempt=99`,
      { method: "POST" });

    expect(res.status).toBe(200);
    const xml = await res.text();

    // The token round-trips into a stream URL Twilio can still use.
    expect(xml).toContain(
      `wss://127.0.0.1:${port}/twilio/stream/${encodeURIComponent(token)}`);

    // No raw metacharacter from the token leaked into the URL attribute
    // itself (as opposed to appearing percent-encoded).
    const streamUrl = xml.match(/<Stream url="([^"]*)"/)?.[1];
    expect(streamUrl).toBeTruthy();
    expect(streamUrl).not.toMatch(/[&<>"]/);

    // And the document is well-formed: every ampersand that survived is
    // part of a real entity reference, never a bare one that would make
    // Twilio's XML parser reject the whole document.
    expect(xml.match(/&(?!amp;|lt;|gt;|quot;|apos;)/g)).toBeNull();

    expect(xml).toContain("<Response>");
    expect(xml).toContain("</Response>");
    expect(xml).toContain("<Dial>+15551234567</Dial>");
  });
});

describe("ring, connect, or fall back", () => {
  it("rings and asks Twilio to check again when the watch is absent", async () => {
    const { port } = start("+15551234567");

    const xml = await (await fetch(`${base(port)}/twilio/voice?token=good`, {
      method: "POST",
    })).text();

    expect(xml).toContain("<Play>");
    expect(xml).toContain("ringback.wav");
    expect(xml).toContain("attempt=2");
    expect(xml).not.toContain("<Connect>");
  });

  it("connects the stream once the watch has said it is ready", async () => {
    const { port } = start("+15551234567");
    // ready=1 is what marks presence — see the test below for why a plain
    // poll deliberately does not.
    await fetch(`${base(port)}/v1/call?token=good&ready=1`);

    const xml = await (await fetch(`${base(port)}/twilio/voice?token=good`, {
      method: "POST",
    })).text();

    expect(xml).toContain("<Connect>");
    expect(xml).toContain(`wss://127.0.0.1:${port}/twilio/stream/good`);
  });

  // Presence must mean "the call screen is up and waiting", not "the app is
  // running". The watch probes this route on every launch to decide whether
  // to open call captions; if that counted, opening the app to browse
  // transcripts would silently arm <Connect> for ten seconds — handing a real
  // call to a watch sitting on the History screen, with nothing polling, no
  // ringback left, and no way for the user to tell.
  it("does not count a plain poll as the watch being ready for a call", async () => {
    const { port } = start("+15551234567");
    await fetch(`${base(port)}/v1/call?token=good`);

    const xml = await (await fetch(`${base(port)}/twilio/voice?token=good`, {
      method: "POST",
    })).text();

    expect(xml).not.toContain("<Connect>");
    expect(xml).toContain("ringback.wav");
  });

  it("falls back to the second line once the budget is spent", async () => {
    const { port } = start("+15551234567");

    const xml = await (await fetch(`${base(port)}/twilio/voice?token=good&attempt=99`, {
      method: "POST",
    })).text();

    expect(xml).toContain("<Dial>+15551234567</Dial>");
    expect(xml).not.toContain("<Play>");
  });

  // `attempt` is user-reachable — anyone holding the token can request
  // /twilio/voice directly with any value. Unclamped, a huge value could
  // hang forever: for |attempt| beyond ~9e15, IEEE-754 makes `attempt + 1
  // === attempt`, so the redirect keeps encoding the same still-in-budget
  // value and the call rings indefinitely. A negative value rings well past
  // the intended ~20s budget before terminating. Malformed input of any of
  // these shapes must land on the fallback branch immediately rather than
  // being trusted to keep ringing.
  it.each([
    ["a negative attempt", "-3"],
    ["a non-integer attempt", "2.5"],
    ["an attempt past Number.MAX_SAFE_INTEGER", "1e16"],
  ])("treats %s as budget already spent, not a fresh ring", async (_label, attempt) => {
    const { port } = start("+15551234567");

    const xml = await (await fetch(
      `${base(port)}/twilio/voice?token=good&attempt=${attempt}`,
      { method: "POST" },
    )).text();

    expect(xml).toContain("<Dial>+15551234567</Dial>");
    expect(xml).not.toContain("<Play>");
  });

  // The fallback keeps a stream so the call is still captioned, but that
  // stream is <Start><Stream> — one-way. The relay has to be able to tell,
  // and Twilio drops the query string, so the marker rides in the path.
  it("marks the fallback stream as the one-way stream it is", async () => {
    const { port } = start("+15551234567");

    const xml = await (await fetch(`${base(port)}/twilio/voice?token=good&attempt=99`, {
      method: "POST",
    })).text();

    expect(xml).toContain(`wss://127.0.0.1:${port}/twilio/stream/good/fallback`);
  });

  // waitAttempts was declared and never passed by anything, so the budget was
  // whatever the default happened to be, unconfigurable.
  it("honours a configured wait budget", async () => {
    const { port } = start("+15551234567", "good", { waitAttempts: 1 });

    const xml = await (await fetch(`${base(port)}/twilio/voice?token=good`, {
      method: "POST",
    })).text();

    // Budget of one means the very first attempt is already the last.
    expect(xml).toContain("<Dial>+15551234567</Dial>");
    expect(xml).not.toContain("<Play>");
  });

  it("serves the ringback tone without a token, because Twilio fetches it", async () => {
    const { port } = start("+15551234567");

    const res = await fetch(`${base(port)}/twilio/ringback.wav`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("audio/wav");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.subarray(0, 4).toString("ascii")).toBe("RIFF");
  });
});

describe("call audio", () => {
  it("serves nothing but a cursor when there is no audio", async () => {
    const { port } = start("+15551234567");

    const res = await fetch(`${base(port)}/v1/call/audio?token=good&since=0`);

    expect(res.status).toBe(200);
    expect(res.headers.get("x-seq")).toBe("0");
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  it("rejects audio requests without a valid token", async () => {
    const { port } = start("+15551234567");
    expect((await fetch(`${base(port)}/v1/call/audio`)).status).toBe(401);
    expect((await fetch(`${base(port)}/v1/call/audio?token=bad`, { method: "POST" })).status)
      .toBe(401);
  });

  // Nothing to speak into: better a clear refusal than silently dropping it.
  it("409s uplink audio when no call is live", async () => {
    const { port } = start("+15551234567");

    const res = await fetch(`${base(port)}/v1/call/audio?token=good`, {
      method: "POST",
      body: Buffer.alloc(800),
    });

    expect(res.status).toBe(409);
  });

  it("carries the caller's audio through to the watch", async () => {
    const { port } = start("+15551234567");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/twilio/stream/good`);
    await new Promise((resolve) => ws.on("open", resolve));
    ws.send(JSON.stringify({
      event: "start", streamSid: "MZa", start: { callSid: "CAa", streamSid: "MZa" },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    ws.send(JSON.stringify({
      event: "media", media: { payload: Buffer.from([0xff, 0xfe]).toString("base64") },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const res = await fetch(`${base(port)}/v1/call/audio?token=good&since=0`);

    expect([...Buffer.from(await res.arrayBuffer())]).toEqual([0xff, 0xfe]);
    expect(Number(res.headers.get("x-seq"))).toBeGreaterThan(0);
    ws.close();
  });

  // The 409 test above only proves the guard fires when no call is live; it
  // says nothing about the path that matters more — a live call, a real
  // conversion, and the result actually reaching the socket Twilio reads
  // from. Wire all three together and read the frame back off the same
  // WebSocket the live stream uses, the way the downlink test above does.
  it("converts a live POST's PCM to mu-law and writes it through to Twilio", async () => {
    const { port } = start("+15551234567");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/twilio/stream/good`);
    const frames: any[] = [];
    ws.on("message", (data: Buffer) => frames.push(JSON.parse(data.toString())));
    await new Promise((resolve) => ws.on("open", resolve));
    ws.send(JSON.stringify({
      event: "start", streamSid: "MZc", start: { callSid: "CAc", streamSid: "MZc" },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 8 samples of 16 kHz little-endian Int16 — pcm16kToMuLaw8k halves the
    // sample count by averaging pairs, so this must yield 4 mu-law bytes.
    const pcm = Buffer.alloc(16);
    for (let i = 0; i < 8; i++) pcm.writeInt16LE((i + 1) * 1000, i * 2);

    const res = await fetch(`${base(port)}/v1/call/audio?token=good`, {
      method: "POST",
      body: pcm,
    });

    expect(res.status).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const media = frames.find((f) => f.event === "media");
    expect(media).toBeTruthy();
    expect(media.streamSid).toBe("MZc");
    const onWire = Buffer.from(media.media.payload, "base64");
    expect(onWire.length).toBe(pcm.length / 4); // half the 8-sample count: 4 bytes
    expect(onWire).toEqual(pcm16kToMuLaw8k(pcm));
    ws.close();
  });
});

describe("POST /v1/call/end", () => {
  it("rejects a hangup without a valid token", async () => {
    const { port } = start("+15551234567");
    expect((await fetch(`${base(port)}/v1/call/end`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${base(port)}/v1/call/end?token=bad`, { method: "POST" })).status)
      .toBe(401);
  });

  it("409s when there is no call to end", async () => {
    const { port } = start("+15551234567");

    const res = await fetch(`${base(port)}/v1/call/end?token=good`, { method: "POST" });

    expect(res.status).toBe(409);
  });

  // Under <Connect><Stream> the call lives exactly as long as this socket, and
  // the watch is not a party to it. Without this route, tapping Stop returned
  // the watch to its menu and left the caller connected to silence — billed,
  // indefinitely, until they gave up.
  it("closes the live call's stream, which is what ends the call", async () => {
    const { port } = start("+15551234567");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/twilio/stream/good`);
    const closed = new Promise((resolve) => ws.on("close", resolve));
    await new Promise((resolve) => ws.on("open", resolve));
    ws.send(JSON.stringify({
      event: "start", streamSid: "MZe", start: { callSid: "CAe", streamSid: "MZe" },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const res = await fetch(`${base(port)}/v1/call/end?token=good`, { method: "POST" });

    expect(res.status).toBe(200);
    await closed;
    const body = await (await fetch(`${base(port)}/v1/call?token=good`)).json();
    expect(body.active).toBe(false);
    // Hanging up is the call ending, not the stream dying under a live call.
    expect(body.reason).toBe("ended");
  });
});

// <Start><Stream> reaches the same WebSocket endpoint as <Connect><Stream>,
// and the two must not be treated alike: the fallback is one-way, the phone
// holds that call, and pushing media at it risks erroring the very stream the
// captions ride on.
describe("a fallback call", () => {
  async function startFallbackCall(port: number) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/twilio/stream/good/fallback`);
    await new Promise((resolve) => ws.on("open", resolve));
    ws.send(JSON.stringify({
      event: "start", streamSid: "MZf", start: { callSid: "CAf", streamSid: "MZf" },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    return ws;
  }

  it("tells the watch it is captions only", async () => {
    const { port } = start("+15551234567");
    const ws = await startFallbackCall(port);

    const body = await (await fetch(`${base(port)}/v1/call?token=good`)).json();

    expect(body.active).toBe(true);
    expect(body.twoWay).toBe(false);
    ws.close();
  });

  it("refuses your voice rather than dropping it into a stream Twilio ignores", async () => {
    const { port } = start("+15551234567");
    const ws = await startFallbackCall(port);

    const res = await fetch(`${base(port)}/v1/call/audio?token=good`, {
      method: "POST",
      body: Buffer.alloc(800),
    });

    expect(res.status).toBe(409);
    ws.close();
  });

  it("serves no caller audio, so the watch never plays a call held on the phone", async () => {
    const { port } = start("+15551234567");
    const ws = await startFallbackCall(port);
    ws.send(JSON.stringify({
      event: "media", media: { payload: Buffer.from([0xff, 0xfe]).toString("base64") },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const res = await fetch(`${base(port)}/v1/call/audio?token=good&since=0`);

    expect((await res.arrayBuffer()).byteLength).toBe(0);
    ws.close();
  });

  it("cannot be hung up from the watch", async () => {
    const { port } = start("+15551234567");
    const ws = await startFallbackCall(port);

    const res = await fetch(`${base(port)}/v1/call/end?token=good`, { method: "POST" });

    expect(res.status).toBe(409);
    ws.close();
  });

  // A held call is the opposite on every count, and that contrast is the
  // point of the flag.
  it("is distinguishable from a call the watch holds", async () => {
    const { port } = start("+15551234567");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/twilio/stream/good`);
    await new Promise((resolve) => ws.on("open", resolve));
    ws.send(JSON.stringify({
      event: "start", streamSid: "MZg", start: { callSid: "CAg", streamSid: "MZg" },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const body = await (await fetch(`${base(port)}/v1/call?token=good`)).json();

    expect(body.twoWay).toBe(true);
    ws.close();
  });
});
