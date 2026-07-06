import { describe, it, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import { AddressInfo } from "net";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { startServer, CaptionServer, ProviderOptions } from "./server";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";
import { TranscriptStore, listTranscripts } from "./transcriptStore";

let running: CaptionServer | null = null;

afterEach(async () => {
  if (running) await running.close();
  running = null;
});

/** Start a server whose providers are fakes the test can capture. */
function startWithFakes(authToken: string) {
  const providers: FakeTranscriptionProvider[] = [];
  const server = startServer({
    port: 0,
    authToken,
    createProvider: () => {
      const p = new FakeTranscriptionProvider();
      providers.push(p);
      return p;
    },
  });
  running = server;
  const port = (server.address() as AddressInfo).port;
  return { server, providers, port };
}

function waitForMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => resolve(JSON.parse(data.toString())));
    ws.once("error", reject);
  });
}

describe("caption server", () => {
  it("rejects a connection with a bad token", async () => {
    const { port } = startWithFakes("good");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/stream?token=bad`);
    const code = await new Promise<number>((resolve) => {
      ws.on("close", (c) => resolve(c));
    });
    expect(code).toBe(4001);
  });

  it("rejects a connection with no token param", async () => {
    const { port } = startWithFakes("good");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/stream`);
    const code = await new Promise<number>((resolve) => {
      ws.on("close", (c) => resolve(c));
    });
    expect(code).toBe(4001);
  });

  it("answers GET /healthz with 200 ok", async () => {
    const { port } = startWithFakes("good");
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("relays transcripts from provider to client as caption messages", async () => {
    const { providers, port } = startWithFakes("good");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/stream?token=good`);
    await new Promise((r) => ws.on("open", r));

    // Provider was created on connection; drive it.
    const provider = providers[0];
    provider.emitReady();
    const ready = await waitForMessage(ws);
    expect(ready).toEqual({ type: "ready" });

    ws.send(Buffer.from("audio-bytes"));
    // Audio reached the provider.
    await new Promise((r) => setTimeout(r, 20));
    expect(Buffer.concat(provider.receivedAudio).toString()).toBe("audio-bytes");

    provider.emitTranscript({ text: "hello world", isFinal: true });
    const caption = await waitForMessage(ws);
    expect(caption).toEqual({ type: "caption", text: "hello world", isFinal: true });

    ws.close();
  });

  it("closes the provider when the client disconnects", async () => {
    const { providers, port } = startWithFakes("good");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/stream?token=good`);
    await new Promise((r) => ws.on("open", r));
    const provider = providers[0];
    ws.close();
    await new Promise((r) => setTimeout(r, 30));
    expect(provider.closed).toBe(true);
  });

  it("passes channels=2 through to the provider factory", async () => {
    const seen: (ProviderOptions | undefined)[] = [];
    const server = startServer({
      port: 0,
      authToken: "good",
      createProvider: (o) => {
        seen.push(o);
        return new FakeTranscriptionProvider();
      },
    });
    running = server;
    const port = (server.address() as AddressInfo).port;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/stream?token=good&channels=2`);
    await new Promise((r) => ws.on("open", r));

    expect(seen[0]).toEqual({ channels: 2 });

    ws.close();
  });

  it("persists and finalizes transcripts for WS sessions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "transcripts-ws-"));
    try {
      const providers: FakeTranscriptionProvider[] = [];
      const server = startServer({
        port: 0,
        authToken: "good",
        createProvider: () => {
          const p = new FakeTranscriptionProvider();
          providers.push(p);
          return p;
        },
        transcripts: new TranscriptStore({ dir }),
        transcriptsDir: dir,
      });
      running = server;
      const port = (server.address() as AddressInfo).port;

      const ws = new WebSocket(`ws://127.0.0.1:${port}/stream?token=good`);
      await new Promise((r) => ws.on("open", r));

      providers[0].emitTranscript({ text: "ws line", isFinal: true, channel: 0 });

      ws.close();
      await new Promise((r) => setTimeout(r, 20));

      const transcripts = listTranscripts(dir);
      expect(transcripts).toHaveLength(1);
      expect(transcripts[0].segmentCount).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
