import { describe, it, expect, afterEach } from "vitest";
import { AddressInfo } from "net";
import { startServer, CaptionServer } from "./server";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";

let running: CaptionServer | null = null;

afterEach(async () => {
  if (running) await running.close();
  running = null;
});

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
  return { providers, port };
}

describe("resume", () => {
  it("binds the session to an existing transcript when ?resume= is given", async () => {
    const reopened: Array<[string, string]> = [];
    const server = startServer({
      port: 0,
      authToken: "t",
      createProvider: () => new FakeTranscriptionProvider(),
      transcripts: {
        reopen: (sessionId: string, name: string) => reopened.push([sessionId, name]),
        append: () => {},
        finalize: () => {},
        finalizeAll: () => {},
      } as any,
    });
    running = server;
    const port = (server.address() as AddressInfo).port;

    await fetch(
      `http://127.0.0.1:${port}/v1/audio?session=s1&token=t&resume=2026-07-06T01-02-03Z_abc`,
      { method: "POST", body: new Uint8Array(0) },
    );

    expect(reopened).toEqual([["s1", "2026-07-06T01-02-03Z_abc"]]);
  });

  it("only reopens once, not on every audio post for the session", async () => {
    const reopened: string[] = [];
    const server = startServer({
      port: 0,
      authToken: "t",
      createProvider: () => new FakeTranscriptionProvider(),
      transcripts: {
        reopen: (_id: string, name: string) => reopened.push(name),
        append: () => {},
        finalize: () => {},
        finalizeAll: () => {},
      } as any,
    });
    running = server;
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/v1/audio?session=s1&token=t&resume=2026-07-06T01-02-03Z_abc`;

    await fetch(url, { method: "POST", body: new Uint8Array(0) });
    await fetch(url, { method: "POST", body: new Uint8Array(0) });

    expect(reopened).toHaveLength(1);
  });
});

const audio = (port: number, query: string) =>
  `http://127.0.0.1:${port}/v1/audio?${query}`;

describe("HTTP transport", () => {
  it("rejects an audio POST with a bad token", async () => {
    const { port } = startWithFakes("good");
    const res = await fetch(audio(port, "session=s1&token=bad"), { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("rejects an audio POST with no session", async () => {
    const { port } = startWithFakes("good");
    const res = await fetch(audio(port, "token=good"), { method: "POST" });
    expect(res.status).toBe(400);
  });

  it("feeds audio to the provider and returns buffered caption events", async () => {
    const { providers, port } = startWithFakes("good");

    // First POST lazily creates the session and forwards audio.
    let res = await fetch(audio(port, "session=s1&since=0&token=good"), {
      method: "POST",
      body: new Uint8Array(Buffer.from("audio-bytes")),
    });
    expect(res.status).toBe(200);
    expect(providers).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 10));
    expect(Buffer.concat(providers[0].receivedAudio).toString()).toBe("audio-bytes");

    // Drive the provider, then poll for events.
    providers[0].emitReady();
    providers[0].emitTranscript({ text: "hello world", isFinal: true });
    res = await fetch(audio(port, "session=s1&since=0&token=good"), { method: "POST" });
    const body = await res.json();
    expect(body.events).toEqual([
      { seq: 1, type: "ready" },
      { seq: 2, type: "caption", text: "hello world", isFinal: true },
    ]);
    expect(body.seq).toBe(2);
  });

  it("only returns events newer than `since`", async () => {
    const { providers, port } = startWithFakes("good");
    await fetch(audio(port, "session=s1&since=0&token=good"), { method: "POST" });
    providers[0].emitReady();
    providers[0].emitTranscript({ text: "one", isFinal: true });

    const res = await fetch(audio(port, "session=s1&since=1&token=good"), { method: "POST" });
    const body = await res.json();
    expect(body.events).toEqual([{ seq: 2, type: "caption", text: "one", isFinal: true }]);
  });

  it("stop drains remaining events and closes the provider", async () => {
    const { providers, port } = startWithFakes("good");
    await fetch(audio(port, "session=s1&since=0&token=good"), { method: "POST" });
    providers[0].emitReady();

    const res = await fetch(
      `http://127.0.0.1:${port}/v1/stop?session=s1&since=0&token=good`,
      { method: "POST" },
    );
    const body = await res.json();
    expect(body.events).toEqual([{ seq: 1, type: "ready" }]);
    expect(providers[0].closed).toBe(true);
  });
});
