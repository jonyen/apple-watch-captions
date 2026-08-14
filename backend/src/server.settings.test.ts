import { describe, it, expect, afterEach } from "vitest";
import { AddressInfo } from "net";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { startServer, CaptionServer } from "./server";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";
import { IdentityStore } from "./identityStore";
import { openDb } from "./db";
import { DEFAULT_SETTINGS } from "./settings";

let running: CaptionServer | null = null;

afterEach(async () => {
  if (running) await running.close();
  running = null;
});

function start(identity: IdentityStore, settingsFile?: string) {
  const providers: { opts?: unknown }[] = [];
  const server = startServer({
    port: 0,
    identity,
    createProvider: (opts) => {
      providers.push({ opts });
      return new FakeTranscriptionProvider();
    },
    settingsFile,
  });
  running = server;
  return { port: (server.address() as AddressInfo).port, providers };
}

const base = (port: number) => `http://127.0.0.1:${port}`;

function authHeaders(token: string) {
  return { authorization: `Bearer ${token}` };
}

const get = (port: number, token: string) =>
  fetch(`${base(port)}/v1/settings`, { headers: authHeaders(token) });

const put = (port: number, body: unknown, token: string) =>
  fetch(`${base(port)}/v1/settings`, {
    method: "PUT",
    headers: authHeaders(token),
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("/v1/settings", () => {
  it("rejects reads and writes without the token", async () => {
    const identity = new IdentityStore(openDb(":memory:"));
    const { port } = start(identity);

    expect((await get(port, "wrong")).status).toBe(401);
    expect((await put(port, {}, "wrong")).status).toBe(401);
  });

  it("returns defaults before anything has been written", async () => {
    const identity = new IdentityStore(openDb(":memory:"));
    const device = identity.registerDevice("watch");
    const { port } = start(identity);

    const res = await get(port, device.token);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(DEFAULT_SETTINGS);
  });

  it("applies a partial write and leaves the rest alone", async () => {
    const identity = new IdentityStore(openDb(":memory:"));
    const device = identity.registerDevice("watch");
    const { port } = start(identity);

    const written = await (await put(port, { captionTextSize: 22 }, device.token)).json();

    expect(written.captionTextSize).toBe(22);
    expect(written.saveTranscripts).toBe(DEFAULT_SETTINGS.saveTranscripts);
    expect((await (await get(port, device.token)).json()).captionTextSize).toBe(22);
  });

  it("clamps a value that would break the watch rather than storing it", async () => {
    const identity = new IdentityStore(openDb(":memory:"));
    const device = identity.registerDevice("watch");
    const { port } = start(identity);

    expect(
      (await (await put(port, { captionTextSize: 999 }, device.token)).json()).captionTextSize,
    ).toBe(30);
  });

  it("rejects a body that is not JSON", async () => {
    const identity = new IdentityStore(openDb(":memory:"));
    const device = identity.registerDevice("watch");
    const { port } = start(identity);

    expect((await put(port, "{ nope", device.token)).status).toBe(400);
  });

  it("persists across a restart when given a file", async () => {
    const identity = new IdentityStore(openDb(":memory:"));
    const device = identity.registerDevice("watch");
    const file = join(mkdtempSync(join(tmpdir(), "relay-")), "settings.json");
    const first = start(identity, file);
    await put(first.port, { captionTextSize: 28 }, device.token);
    await running!.close();
    running = null;

    const second = start(identity, file);

    expect((await (await get(second.port, device.token)).json()).captionTextSize).toBe(28);
  });

  it("transcribes new sessions with the configured provider", async () => {
    const identity = new IdentityStore(openDb(":memory:"));
    const device = identity.registerDevice("watch");
    const { port, providers } = start(identity);

    await put(port, { provider: "openai" }, device.token);
    await fetch(`${base(port)}/v1/audio?session=s1&ephemeral=1`, {
      method: "POST",
      headers: authHeaders(device.token),
      body: Buffer.alloc(320),
    });

    expect(providers.at(-1)?.opts).toMatchObject({ provider: "openai" });
  });
});
