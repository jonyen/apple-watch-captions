import { describe, it, expect, afterEach } from "vitest";
import { AddressInfo } from "net";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { startServer, CaptionServer } from "./server";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";
import { DEFAULT_SETTINGS } from "./settings";

let running: CaptionServer | null = null;

afterEach(async () => {
  if (running) await running.close();
  running = null;
});

function start(settingsFile?: string) {
  const providers: { opts?: unknown }[] = [];
  const server = startServer({
    port: 0,
    authToken: "good",
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

const get = (port: number, token = "good") =>
  fetch(`${base(port)}/v1/settings?token=${token}`);

const put = (port: number, body: unknown, token = "good") =>
  fetch(`${base(port)}/v1/settings?token=${token}`, {
    method: "PUT",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("/v1/settings", () => {
  it("rejects reads and writes without the token", async () => {
    const { port } = start();

    expect((await get(port, "wrong")).status).toBe(401);
    expect((await put(port, {}, "wrong")).status).toBe(401);
  });

  it("returns defaults before anything has been written", async () => {
    const { port } = start();

    const res = await get(port);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(DEFAULT_SETTINGS);
  });

  it("applies a partial write and leaves the rest alone", async () => {
    const { port } = start();

    const written = await (await put(port, { captionTextSize: 22 })).json();

    expect(written.captionTextSize).toBe(22);
    expect(written.saveTranscripts).toBe(DEFAULT_SETTINGS.saveTranscripts);
    expect((await (await get(port)).json()).captionTextSize).toBe(22);
  });

  it("clamps a value that would break the watch rather than storing it", async () => {
    const { port } = start();

    expect((await (await put(port, { captionTextSize: 999 })).json()).captionTextSize).toBe(30);
  });

  it("rejects a body that is not JSON", async () => {
    const { port } = start();

    expect((await put(port, "{ nope")).status).toBe(400);
  });

  it("persists across a restart when given a file", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "relay-")), "settings.json");
    const first = start(file);
    await put(first.port, { captionTextSize: 28 });
    await running!.close();
    running = null;

    const second = start(file);

    expect((await (await get(second.port)).json()).captionTextSize).toBe(28);
  });

  it("transcribes new sessions with the configured provider", async () => {
    const { port, providers } = start();

    await put(port, { provider: "openai" });
    await fetch(`${base(port)}/v1/audio?session=s1&token=good&ephemeral=1`, {
      method: "POST",
      body: Buffer.alloc(320),
    });

    expect(providers.at(-1)?.opts).toMatchObject({ provider: "openai" });
  });
});
