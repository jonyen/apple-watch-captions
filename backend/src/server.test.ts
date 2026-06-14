import { describe, it, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import { AddressInfo } from "net";
import { startServer, CaptionServer } from "./server";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";

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
});
