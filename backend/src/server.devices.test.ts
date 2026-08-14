import { describe, it, expect, afterEach } from "vitest";
import { startServer, CaptionServer } from "./server";
import { IdentityStore } from "./identityStore";
import { openDb } from "./db";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";

let server: CaptionServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function start(): { port: number; identity: IdentityStore } {
  const identity = new IdentityStore(openDb(":memory:"));
  server = startServer({
    port: 0,
    identity,
    createProvider: () => new FakeTranscriptionProvider(),
  });
  const addr = server.address();
  return { port: typeof addr === "object" && addr ? addr.port : 0, identity };
}

describe("POST /v1/devices", () => {
  it("registers a device and returns a usable token", async () => {
    const { port, identity } = start();
    const res = await fetch(`http://127.0.0.1:${port}/v1/devices`, {
      method: "POST",
      body: JSON.stringify({ kind: "watch" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deviceId: string; userId: string; token: string };
    expect(identity.resolve(body.token)).toEqual({
      userId: body.userId,
      deviceId: body.deviceId,
    });
  });

  it("rejects an unknown device kind", async () => {
    const { port } = start();
    const res = await fetch(`http://127.0.0.1:${port}/v1/devices`, {
      method: "POST",
      body: JSON.stringify({ kind: "toaster" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a malformed body", async () => {
    const { port } = start();
    const res = await fetch(`http://127.0.0.1:${port}/v1/devices`, {
      method: "POST",
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("rate limits repeated registrations from one address", async () => {
    const { port } = start();
    const codes: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const res = await fetch(`http://127.0.0.1:${port}/v1/devices`, {
        method: "POST",
        body: JSON.stringify({ kind: "watch" }),
      });
      codes.push(res.status);
    }
    expect(codes.filter((c) => c === 200)).toHaveLength(10);
    expect(codes.filter((c) => c === 429)).toHaveLength(2);
  });
});
