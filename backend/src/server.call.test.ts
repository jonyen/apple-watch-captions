import { describe, it, expect, afterEach } from "vitest";
import { AddressInfo } from "net";
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
