import { describe, it, expect, afterEach } from "vitest";
import { AddressInfo } from "net";
import { startServer, CaptionServer } from "./server";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";

let running: CaptionServer | null = null;

afterEach(async () => {
  if (running) await running.close();
  running = null;
});

function start(authToken = "good") {
  const server = startServer({
    port: 0,
    authToken,
    createProvider: () => new FakeTranscriptionProvider(),
  });
  running = server;
  return { port: (server.address() as AddressInfo).port };
}

const base = (port: number) => `http://127.0.0.1:${port}`;

const presence = (port: number, session: string, token = "good") =>
  fetch(`${base(port)}/v1/presence?session=${session}&token=${token}`);

/** A reader's poll: an empty POST that marks presence and drains captions. */
const read = (port: number, session: string) =>
  fetch(`${base(port)}/v1/audio?session=${session}&token=good&role=reader&ephemeral=1`, {
    method: "POST",
    body: Buffer.alloc(0),
  });

describe("GET /v1/presence", () => {
  it("rejects a request without the token", async () => {
    const { port } = start();

    const res = await presence(port, "phone-audio", "wrong");

    expect(res.status).toBe(401);
  });

  it("requires a session", async () => {
    const { port } = start();

    const res = await fetch(`${base(port)}/v1/presence?token=good`);

    expect(res.status).toBe(400);
  });

  it("reports no reader before anything has read the session", async () => {
    const { port } = start();

    const res = await presence(port, "phone-audio");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reader: false });
  });

  it("reports a reader once one has polled", async () => {
    const { port } = start();

    await read(port, "phone-audio");
    const res = await presence(port, "phone-audio");

    expect(await res.json()).toEqual({ reader: true });
  });

  it("does not report a reader for a different session", async () => {
    const { port } = start();

    await read(port, "phone-audio");
    const res = await presence(port, "something-else");

    expect(await res.json()).toEqual({ reader: false });
  });

  it("does not count a producer's post as a reader", async () => {
    const { port } = start();

    // The phone posts audio without `role=reader`; that must not make the
    // phone look like its own audience and stream to nobody forever.
    await fetch(`${base(port)}/v1/audio?session=phone-audio&token=good&ephemeral=1`, {
      method: "POST",
      body: Buffer.alloc(320),
    });
    const res = await presence(port, "phone-audio");

    expect(await res.json()).toEqual({ reader: false });
  });

  it("never creates a session, so asking about an unknown one is free", async () => {
    const { port } = start();

    await presence(port, "never-seen");
    const res = await presence(port, "never-seen");

    expect(await res.json()).toEqual({ reader: false });
  });
});
