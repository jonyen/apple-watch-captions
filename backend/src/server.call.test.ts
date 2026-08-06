import { describe, it, expect, afterEach } from "vitest";
import { AddressInfo } from "net";
import WebSocket from "ws";
import { startServer, CaptionServer } from "./server";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";

let running: CaptionServer | null = null;

afterEach(async () => {
  if (running) await running.close();
  running = null;
});

function start(callForwardTo?: string) {
  const providers: FakeTranscriptionProvider[] = [];
  const server = startServer({
    port: 0,
    authToken: "good",
    createProvider: () => {
      const p = new FakeTranscriptionProvider();
      providers.push(p);
      return p;
    },
    callForwardTo,
  });
  running = server;
  return { providers, port: (server.address() as AddressInfo).port };
}

const base = (port: number) => `http://127.0.0.1:${port}`;

describe("POST /twilio/voice", () => {
  it("returns TwiML pointing the stream at this relay", async () => {
    const { port } = start("+15551234567");

    const res = await fetch(`${base(port)}/twilio/voice?token=good`, { method: "POST" });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/xml");
    const xml = await res.text();
    expect(xml).toContain(`wss://127.0.0.1:${port}/twilio/stream?token=good`);
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
    expect(body).toEqual({ active: false, events: [], seq: 0 });
    ws.close();
  });
});
