// The two-way half of call captioning, end to end over HTTP: watch presence
// arming <Connect>, ringback while the caller waits, the caller's audio
// polled down to the watch, push-to-talk audio written back up to Twilio, and
// the hangup route. The single-user flow lives here; the cross-tenant attacks
// on the same routes live in server.tenancy.test.ts.
import { describe, it, expect, afterEach } from "vitest";
import { AddressInfo } from "net";
import WebSocket from "ws";
import { startServer, CaptionServer } from "./server";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";
import { IdentityStore } from "./identityStore";
import { openDb } from "./db";
import { pcm16kToMuLaw8k } from "./mulaw";

let running: CaptionServer | null = null;

afterEach(async () => {
  if (running) await running.close();
  running = null;
});

function start(callForwardTo?: string, extra: { waitAttempts?: number } = {}) {
  const identity = new IdentityStore(openDb(":memory:"));
  const device = identity.registerDevice("watch");
  const providers: FakeTranscriptionProvider[] = [];
  const server = startServer({
    port: 0,
    identity,
    createProvider: () => {
      const p = new FakeTranscriptionProvider();
      providers.push(p);
      return p;
    },
    callForwardTo,
    ...extra,
  });
  running = server;
  return { providers, port: (server.address() as AddressInfo).port, token: device.token };
}

const base = (port: number) => `http://127.0.0.1:${port}`;

describe("ring, connect, or fall back", () => {
  it("rings and asks Twilio to check again when the watch is absent", async () => {
    const { port, token } = start("+15551234567");

    const xml = await (await fetch(`${base(port)}/twilio/voice?token=${token}`, {
      method: "POST",
    })).text();

    expect(xml).toContain("<Play>");
    expect(xml).toContain("ringback.wav");
    expect(xml).toContain("attempt=2");
    expect(xml).not.toContain("<Connect>");
  });

  it("connects the stream once the watch has said it is ready", async () => {
    const { port, token } = start("+15551234567");
    // ready=1 is what marks presence — see the test below for why a plain
    // poll deliberately does not.
    await fetch(`${base(port)}/v1/call?token=${token}&ready=1`);

    const xml = await (await fetch(`${base(port)}/twilio/voice?token=${token}`, {
      method: "POST",
    })).text();

    expect(xml).toContain("<Connect>");
    expect(xml).toContain(`wss://127.0.0.1:${port}/twilio/stream/${token}`);
  });

  // Presence must mean "the call screen is up and waiting", not "the app is
  // running". The watch probes this route on every launch to decide whether
  // to open call captions; if that counted, opening the app to browse
  // transcripts would silently arm <Connect> for ten seconds — handing a real
  // call to a watch sitting on the History screen, with nothing polling, no
  // ringback left, and no way for the user to tell.
  it("does not count a plain poll as the watch being ready for a call", async () => {
    const { port, token } = start("+15551234567");
    await fetch(`${base(port)}/v1/call?token=${token}`);

    const xml = await (await fetch(`${base(port)}/twilio/voice?token=${token}`, {
      method: "POST",
    })).text();

    expect(xml).not.toContain("<Connect>");
    expect(xml).toContain("ringback.wav");
  });

  it("falls back to the second line once the budget is spent", async () => {
    const { port, token } = start("+15551234567");

    const xml = await (await fetch(`${base(port)}/twilio/voice?token=${token}&attempt=99`, {
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
    const { port, token } = start("+15551234567");

    const xml = await (await fetch(
      `${base(port)}/twilio/voice?token=${token}&attempt=${attempt}`,
      { method: "POST" },
    )).text();

    expect(xml).toContain("<Dial>+15551234567</Dial>");
    expect(xml).not.toContain("<Play>");
  });

  // The fallback keeps a stream so the call is still captioned, but that
  // stream is <Start><Stream> — one-way. The relay has to be able to tell,
  // and Twilio drops the query string, so the marker rides in the path.
  it("marks the fallback stream as the one-way stream it is", async () => {
    const { port, token } = start("+15551234567");

    const xml = await (await fetch(`${base(port)}/twilio/voice?token=${token}&attempt=99`, {
      method: "POST",
    })).text();

    expect(xml).toContain(`wss://127.0.0.1:${port}/twilio/stream/${token}/fallback`);
  });

  it("honours a configured wait budget", async () => {
    const { port, token } = start("+15551234567", { waitAttempts: 1 });

    const xml = await (await fetch(`${base(port)}/twilio/voice?token=${token}`, {
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
    const { port, token } = start("+15551234567");

    const res = await fetch(`${base(port)}/v1/call/audio?token=${token}&since=0`);

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
    const { port, token } = start("+15551234567");

    const res = await fetch(`${base(port)}/v1/call/audio?token=${token}`, {
      method: "POST",
      body: Buffer.alloc(800),
    });

    expect(res.status).toBe(409);
  });

  it("carries the caller's audio through to the watch", async () => {
    const { port, token } = start("+15551234567");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/twilio/stream/${token}`);
    await new Promise((resolve) => ws.on("open", resolve));
    ws.send(JSON.stringify({
      event: "start", streamSid: "MZa", start: { callSid: "CAa", streamSid: "MZa" },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    ws.send(JSON.stringify({
      event: "media", media: { payload: Buffer.from([0xff, 0xfe]).toString("base64") },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const res = await fetch(`${base(port)}/v1/call/audio?token=${token}&since=0`);

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
    const { port, token } = start("+15551234567");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/twilio/stream/${token}`);
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

    const res = await fetch(`${base(port)}/v1/call/audio?token=${token}`, {
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
    const { port, token } = start("+15551234567");

    const res = await fetch(`${base(port)}/v1/call/end?token=${token}`, { method: "POST" });

    expect(res.status).toBe(409);
  });

  // Under <Connect><Stream> the call lives exactly as long as this socket, and
  // the watch is not a party to it. Without this route, tapping Stop returned
  // the watch to its menu and left the caller connected to silence — billed,
  // indefinitely, until they gave up.
  it("closes the live call's stream, which is what ends the call", async () => {
    const { port, token } = start("+15551234567");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/twilio/stream/${token}`);
    const closed = new Promise((resolve) => ws.on("close", resolve));
    await new Promise((resolve) => ws.on("open", resolve));
    ws.send(JSON.stringify({
      event: "start", streamSid: "MZe", start: { callSid: "CAe", streamSid: "MZe" },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const res = await fetch(`${base(port)}/v1/call/end?token=${token}`, { method: "POST" });

    expect(res.status).toBe(200);
    await closed;
    const body = await (await fetch(`${base(port)}/v1/call?token=${token}`)).json();
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
  async function startFallbackCall(port: number, token: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/twilio/stream/${token}/fallback`);
    await new Promise((resolve) => ws.on("open", resolve));
    ws.send(JSON.stringify({
      event: "start", streamSid: "MZf", start: { callSid: "CAf", streamSid: "MZf" },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    return ws;
  }

  it("tells the watch it is captions only", async () => {
    const { port, token } = start("+15551234567");
    const ws = await startFallbackCall(port, token);

    const body = await (await fetch(`${base(port)}/v1/call?token=${token}`)).json();

    expect(body.active).toBe(true);
    expect(body.twoWay).toBe(false);
    ws.close();
  });

  it("refuses your voice rather than dropping it into a stream Twilio ignores", async () => {
    const { port, token } = start("+15551234567");
    const ws = await startFallbackCall(port, token);

    const res = await fetch(`${base(port)}/v1/call/audio?token=${token}`, {
      method: "POST",
      body: Buffer.alloc(800),
    });

    expect(res.status).toBe(409);
    ws.close();
  });

  it("serves no caller audio, so the watch never plays a call held on the phone", async () => {
    const { port, token } = start("+15551234567");
    const ws = await startFallbackCall(port, token);
    ws.send(JSON.stringify({
      event: "media", media: { payload: Buffer.from([0xff, 0xfe]).toString("base64") },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const res = await fetch(`${base(port)}/v1/call/audio?token=${token}&since=0`);

    expect((await res.arrayBuffer()).byteLength).toBe(0);
    ws.close();
  });

  it("cannot be hung up from the watch", async () => {
    const { port, token } = start("+15551234567");
    const ws = await startFallbackCall(port, token);

    const res = await fetch(`${base(port)}/v1/call/end?token=${token}`, { method: "POST" });

    expect(res.status).toBe(409);
    ws.close();
  });

  // A held call is the opposite on every count, and that contrast is the
  // point of the flag.
  it("is distinguishable from a call the watch holds", async () => {
    const { port, token } = start("+15551234567");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/twilio/stream/${token}`);
    await new Promise((resolve) => ws.on("open", resolve));
    ws.send(JSON.stringify({
      event: "start", streamSid: "MZg", start: { callSid: "CAg", streamSid: "MZg" },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const body = await (await fetch(`${base(port)}/v1/call?token=${token}`)).json();

    expect(body.twoWay).toBe(true);
    ws.close();
  });
});
