import { describe, it, expect, afterEach } from "vitest";
import { AddressInfo } from "net";
import { startServer, CaptionServer } from "./server";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";
import { IdentityStore } from "./identityStore";
import { openDb } from "./db";

let running: CaptionServer | null = null;

afterEach(async () => {
  if (running) await running.close();
  running = null;
});

function start() {
  const identity = new IdentityStore(openDb(":memory:"));
  const device = identity.registerDevice("watch");
  const server = startServer({
    port: 0,
    identity,
    createProvider: () => new FakeTranscriptionProvider(),
  });
  running = server;
  return { port: (server.address() as AddressInfo).port, token: device.token };
}

const base = (port: number) => `http://127.0.0.1:${port}`;

function authHeaders(token: string) {
  return { authorization: `Bearer ${token}` };
}

const presence = (port: number, session: string, token: string) =>
  fetch(`${base(port)}/v1/presence?session=${session}`, { headers: authHeaders(token) });

/** A reader's poll: an empty POST that marks presence and drains captions. */
const read = (port: number, session: string, token: string) =>
  fetch(`${base(port)}/v1/audio?session=${session}&role=reader&ephemeral=1`, {
    method: "POST",
    headers: authHeaders(token),
    body: Buffer.alloc(0),
  });

describe("GET /v1/presence", () => {
  it("rejects a request without the token", async () => {
    const { port } = start();

    const res = await presence(port, "phone-audio", "wrong");

    expect(res.status).toBe(401);
  });

  it("requires a session", async () => {
    const { port, token } = start();

    const res = await fetch(`${base(port)}/v1/presence`, { headers: authHeaders(token) });

    expect(res.status).toBe(400);
  });

  it("reports no reader before anything has read the session", async () => {
    const { port, token } = start();

    const res = await presence(port, "phone-audio", token);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reader: false, producer: false });
  });

  it("reports a reader once one has polled", async () => {
    const { port, token } = start();

    await read(port, "phone-audio", token);
    const res = await presence(port, "phone-audio", token);

    expect(await res.json()).toEqual({ reader: true, producer: false });
  });

  it("does not report a reader for a different session", async () => {
    const { port, token } = start();

    await read(port, "phone-audio", token);
    const res = await presence(port, "something-else", token);

    expect(await res.json()).toEqual({ reader: false, producer: false });
  });

  it("does not count a producer's post as a reader", async () => {
    const { port, token } = start();

    // The phone posts audio without `role=reader`; that must not make the
    // phone look like its own audience and stream to nobody forever.
    await fetch(`${base(port)}/v1/audio?session=phone-audio&ephemeral=1`, {
      method: "POST",
      headers: authHeaders(token),
      body: Buffer.alloc(320),
    });
    const res = await presence(port, "phone-audio", token);

    expect(await res.json()).toEqual({ reader: false, producer: true });
  });

  it("reports no producer until audio actually arrives", async () => {
    const { port, token } = start();

    // An empty post is a reader's poll, not a broadcast: it must not make the
    // watch think the phone is playing something.
    await read(port, "phone-audio", token);
    const res = await presence(port, "phone-audio", token);

    expect((await res.json()).producer).toBe(false);
  });

  it("never creates a session, so asking about an unknown one is free", async () => {
    const { port, token } = start();

    await presence(port, "never-seen", token);
    const res = await presence(port, "never-seen", token);

    expect(await res.json()).toEqual({ reader: false, producer: false });
  });

  it("marks a broadcast present on POST, before any audio flows", async () => {
    const { port, token } = start();

    // The deadlock this breaks: the phone streams only once a reader appears,
    // and the watch opens only once a producer does. Announcing the broadcast
    // itself is what lets one of them go first.
    const res = await fetch(
      `${base(port)}/v1/presence?session=phone-audio&role=producer`,
      { method: "POST", headers: authHeaders(token) },
    );

    expect(await res.json()).toEqual({ reader: false, producer: true });
  });

  it("answers the reader question in the same request the producer marks itself", async () => {
    const { port, token } = start();
    await read(port, "phone-audio", token);

    const res = await fetch(
      `${base(port)}/v1/presence?session=phone-audio&role=producer`,
      { method: "POST", headers: authHeaders(token) },
    );

    expect(await res.json()).toEqual({ reader: true, producer: true });
  });

  it("does not mark anything on GET", async () => {
    const { port, token } = start();

    await presence(port, "phone-audio", token);
    const res = await presence(port, "phone-audio", token);

    expect(await res.json()).toEqual({ reader: false, producer: false });
  });
});
