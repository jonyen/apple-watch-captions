import { describe, it, expect, afterEach } from "vitest";
import { startServer, CaptionServer, RegistrationLimiter } from "./server";
import { IdentityStore } from "./identityStore";
import { openDb } from "./db";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";

let server: CaptionServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function start(options: { trustProxyHeaders?: boolean } = {}): {
  port: number;
  identity: IdentityStore;
} {
  const identity = new IdentityStore(openDb(":memory:"));
  server = startServer({
    port: 0,
    identity,
    trustProxyHeaders: options.trustProxyHeaders,
    createProvider: () => new FakeTranscriptionProvider(),
  });
  const addr = server.address();
  return { port: typeof addr === "object" && addr ? addr.port : 0, identity };
}

function register(port: number, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/devices`, {
    method: "POST",
    headers,
    body: JSON.stringify({ kind: "watch" }),
  });
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

  it("responds 503 when no identity store is configured", async () => {
    server = startServer({
      port: 0,
      createProvider: () => new FakeTranscriptionProvider(),
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const res = await register(port);
    expect(res.status).toBe(503);
  });
});

describe("POST /v1/devices rate-limit key and proxy trust", () => {
  it("ignores X-Forwarded-For when trustProxyHeaders is off — different values share one bucket", async () => {
    const { port } = start();
    for (let i = 0; i < 10; i += 1) {
      const res = await register(port, { "x-forwarded-for": "1.1.1.1" });
      expect(res.status).toBe(200);
    }
    // Same underlying loopback connection, different forwarded header: still
    // limited, because the header must not be trusted by default.
    const res = await register(port, { "x-forwarded-for": "2.2.2.2" });
    expect(res.status).toBe(429);
  });

  it("keys on Fly-Client-IP when trustProxyHeaders is on — different values get independent buckets", async () => {
    const { port } = start({ trustProxyHeaders: true });
    for (let i = 0; i < 10; i += 1) {
      const res = await register(port, { "fly-client-ip": "9.9.9.1" });
      expect(res.status).toBe(200);
    }
    const exhausted = await register(port, { "fly-client-ip": "9.9.9.1" });
    expect(exhausted.status).toBe(429);

    const other = await register(port, { "fly-client-ip": "9.9.9.2" });
    expect(other.status).toBe(200);
  });

  it("ignores X-Forwarded-For even when trustProxyHeaders is on, absent Fly-Client-IP", async () => {
    // Fly's edge appends its observed address to any X-Forwarded-For it
    // receives rather than replacing it, so a client-chosen left-most entry
    // survives to the app. Only Fly-Client-IP is trustworthy; X-Forwarded-For
    // must never be consulted, with or without the flag.
    const { port } = start({ trustProxyHeaders: true });
    for (let i = 0; i < 10; i += 1) {
      const res = await register(port, { "x-forwarded-for": "1.1.1.1" });
      expect(res.status).toBe(200);
    }
    const res = await register(port, { "x-forwarded-for": "2.2.2.2" });
    expect(res.status).toBe(429);
  });
});

describe("RegistrationLimiter eviction", () => {
  it("drops a stale address's bucket instead of holding it forever", () => {
    let now = 0;
    const limiter = new RegistrationLimiter(() => now);
    limiter.allow("1.2.3.4");
    expect(limiter.size()).toBe(1);

    // Past the window: the old address's hits have all aged out.
    now += 61 * 60_000;
    limiter.allow("5.6.7.8");
    expect(limiter.size()).toBe(1);
  });
});
