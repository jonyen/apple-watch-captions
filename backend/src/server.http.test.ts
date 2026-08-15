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

function authHeaders(token: string) {
  return { authorization: `Bearer ${token}` };
}

function startWithFakes() {
  const identity = new IdentityStore(openDb(":memory:"));
  const device = identity.registerDevice("watch");
  const providers: FakeTranscriptionProvider[] = [];
  const server = startServer({
    port: 0,
    identity,
    createProvider: () => {
      const p = new FakeTranscriptionProvider();
      providers.push(p);
      return p;
    },
  });
  running = server;
  const port = (server.address() as AddressInfo).port;
  return { providers, port, token: device.token };
}

describe("resume", () => {
  it("binds the session to an existing transcript when ?resume= is given", async () => {
    const identity = new IdentityStore(openDb(":memory:"));
    const device = identity.registerDevice("watch");
    const reopened: Array<[string, string]> = [];
    const server = startServer({
      port: 0,
      identity,
      createProvider: () => new FakeTranscriptionProvider(),
      transcripts: {
        reopen: (_userId: string, sessionId: string, name: string) =>
          reopened.push([sessionId, name]),
        append: () => {},
        finalize: () => {},
        finalizeAll: () => {},
      } as any,
    });
    running = server;
    const port = (server.address() as AddressInfo).port;

    await fetch(
      `http://127.0.0.1:${port}/v1/audio?session=s1&resume=2026-07-06T01-02-03Z_abc`,
      { method: "POST", headers: authHeaders(device.token), body: new Uint8Array(0) },
    );

    expect(reopened).toEqual([["s1", "2026-07-06T01-02-03Z_abc"]]);
  });

  it("only reopens once, not on every audio post for the session", async () => {
    const identity = new IdentityStore(openDb(":memory:"));
    const device = identity.registerDevice("watch");
    const reopened: string[] = [];
    const server = startServer({
      port: 0,
      identity,
      createProvider: () => new FakeTranscriptionProvider(),
      transcripts: {
        reopen: (_userId: string, _id: string, name: string) => reopened.push(name),
        append: () => {},
        finalize: () => {},
        finalizeAll: () => {},
      } as any,
    });
    running = server;
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/v1/audio?session=s1&resume=2026-07-06T01-02-03Z_abc`;

    await fetch(url, { method: "POST", headers: authHeaders(device.token), body: new Uint8Array(0) });
    await fetch(url, { method: "POST", headers: authHeaders(device.token), body: new Uint8Array(0) });

    expect(reopened).toHaveLength(1);
  });
});

const audio = (port: number, query: string) =>
  `http://127.0.0.1:${port}/v1/audio?${query}`;

describe("HTTP transport", () => {
  it("rejects an audio POST with a bad token", async () => {
    const { port } = startWithFakes();
    const res = await fetch(audio(port, "session=s1"), {
      method: "POST",
      headers: authHeaders("bad"),
    });
    expect(res.status).toBe(401);
  });

  it("rejects an audio POST with no session", async () => {
    const { port, token } = startWithFakes();
    const res = await fetch(audio(port, ""), { method: "POST", headers: authHeaders(token) });
    expect(res.status).toBe(400);
  });

  it("feeds audio to the provider and returns buffered caption events", async () => {
    const { providers, port, token } = startWithFakes();

    // First POST lazily creates the session and forwards audio.
    let res = await fetch(audio(port, "session=s1&since=0"), {
      method: "POST",
      headers: authHeaders(token),
      body: new Uint8Array(Buffer.from("audio-bytes")),
    });
    expect(res.status).toBe(200);
    expect(providers).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 10));
    expect(Buffer.concat(providers[0].receivedAudio).toString()).toBe("audio-bytes");

    // Drive the provider, then poll for events.
    providers[0].emitReady();
    providers[0].emitTranscript({ text: "hello world", isFinal: true });
    res = await fetch(audio(port, "session=s1&since=0"), {
      method: "POST",
      headers: authHeaders(token),
    });
    const body = await res.json();
    expect(body.events).toEqual([
      { seq: 1, type: "ready" },
      { seq: 2, type: "caption", text: "hello world", isFinal: true },
    ]);
    expect(body.seq).toBe(2);
  });

  it("only returns events newer than `since`", async () => {
    const { providers, port, token } = startWithFakes();
    await fetch(audio(port, "session=s1&since=0"), { method: "POST", headers: authHeaders(token) });
    providers[0].emitReady();
    providers[0].emitTranscript({ text: "one", isFinal: true });

    const res = await fetch(audio(port, "session=s1&since=1"), {
      method: "POST",
      headers: authHeaders(token),
    });
    const body = await res.json();
    expect(body.events).toEqual([{ seq: 2, type: "caption", text: "one", isFinal: true }]);
  });

  it("stop drains remaining events and closes the provider", async () => {
    const { providers, port, token } = startWithFakes();
    await fetch(audio(port, "session=s1&since=0"), { method: "POST", headers: authHeaders(token) });
    providers[0].emitReady();

    const res = await fetch(
      `http://127.0.0.1:${port}/v1/stop?session=s1&since=0`,
      { method: "POST", headers: authHeaders(token) },
    );
    const body = await res.json();
    expect(body.events).toEqual([{ seq: 1, type: "ready" }]);
    expect(providers[0].closed).toBe(true);
  });
});

describe("provider selection", () => {
  it("uses the provider named on the request", async () => {
    const seen: (string | undefined)[] = [];
    const identity = new IdentityStore(openDb(":memory:"));
    const device = identity.registerDevice("watch");
    const server = startServer({
      port: 0,
      identity,
      createProvider: (o) => {
        seen.push(o?.provider);
        return new FakeTranscriptionProvider();
      },
    });
    running = server;
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    await fetch(`http://127.0.0.1:${port}/v1/audio?session=s1&provider=openai`, {
      method: "POST",
      headers: { authorization: `Bearer ${device.token}` },
      body: Buffer.alloc(3200),
    });
    expect(seen).toEqual(["openai"]);
  });

  it("ignores an unknown provider rather than failing the request", async () => {
    const seen: (string | undefined)[] = [];
    const identity = new IdentityStore(openDb(":memory:"));
    const device = identity.registerDevice("watch");
    const server = startServer({
      port: 0,
      identity,
      createProvider: (o) => {
        seen.push(o?.provider);
        return new FakeTranscriptionProvider();
      },
    });
    running = server;
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    const res = await fetch(`http://127.0.0.1:${port}/v1/audio?session=s1&provider=toaster`, {
      method: "POST",
      headers: { authorization: `Bearer ${device.token}` },
      body: Buffer.alloc(3200),
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual([undefined]);
  });

  it("ignores a provider named on a later post to an already-created session", async () => {
    const seen: (string | undefined)[] = [];
    const identity = new IdentityStore(openDb(":memory:"));
    const device = identity.registerDevice("watch");
    const server = startServer({
      port: 0,
      identity,
      createProvider: (o) => {
        seen.push(o?.provider);
        return new FakeTranscriptionProvider();
      },
    });
    running = server;
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    await fetch(`http://127.0.0.1:${port}/v1/audio?session=s1&provider=openai`, {
      method: "POST",
      headers: { authorization: `Bearer ${device.token}` },
      body: Buffer.alloc(3200),
    });
    await fetch(`http://127.0.0.1:${port}/v1/audio?session=s1&provider=assemblyai`, {
      method: "POST",
      headers: { authorization: `Bearer ${device.token}` },
      body: Buffer.alloc(3200),
    });
    // The session was already created with openai; the second post's provider
    // name must not swap the engine mid-conversation.
    expect(seen).toEqual(["openai"]);
  });
});

describe("ephemeral sessions", () => {
  function startWithTranscriptSpy() {
    const identity = new IdentityStore(openDb(":memory:"));
    const device = identity.registerDevice("watch");
    const appended: string[] = [];
    const finalized: string[] = [];
    const reopened: Array<[string, string]> = [];
    const server = startServer({
      port: 0,
      identity,
      createProvider: () => new FakeTranscriptionProvider(),
      transcripts: {
        append: (_userId: string, _id: string, text: string) => appended.push(text),
        finalize: (_userId: string, id: string) => finalized.push(id),
        reopen: (_userId: string, id: string, name: string) => reopened.push([id, name]),
        finalizeAll: () => {},
        activeName: () => "2026-07-29T10-00-00Z_s1",
      } as any,
    });
    running = server;
    const port = (server.address() as AddressInfo).port;
    return { port, appended, finalized, reopened, token: device.token };
  }

  it("omits the transcript name for a live session", async () => {
    const { port, token } = startWithTranscriptSpy();
    const res = await fetch(
      `http://127.0.0.1:${port}/v1/audio?session=s1&ephemeral=1`,
      { method: "POST", headers: authHeaders(token), body: new Uint8Array(0) },
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).not.toHaveProperty("transcript");
  });

  it("still names the transcript for a saved session", async () => {
    const { port, token } = startWithTranscriptSpy();
    const res = await fetch(
      `http://127.0.0.1:${port}/v1/audio?session=s1`,
      { method: "POST", headers: authHeaders(token), body: new Uint8Array(0) },
    );
    const body = await res.json();
    expect(body.transcript).toBe("2026-07-29T10-00-00Z_s1");
  });

  it("ignores resume= for a live session", async () => {
    const { port, reopened, token } = startWithTranscriptSpy();
    await fetch(
      `http://127.0.0.1:${port}/v1/audio?session=s1&ephemeral=1&resume=2026-07-06T01-02-03Z_abc`,
      { method: "POST", headers: authHeaders(token), body: new Uint8Array(0) },
    );
    expect(reopened).toEqual([]);
  });

  it("keeps a live session live across posts and on stop", async () => {
    const { port, appended, finalized, token } = startWithTranscriptSpy();
    await fetch(`http://127.0.0.1:${port}/v1/audio?session=s1&ephemeral=1`, {
      method: "POST",
      headers: authHeaders(token),
      body: new Uint8Array(0),
    });
    // A second post without the flag must not start saving.
    const res = await fetch(`http://127.0.0.1:${port}/v1/audio?session=s1`, {
      method: "POST",
      headers: authHeaders(token),
      body: new Uint8Array(0),
    });
    expect(await res.json()).not.toHaveProperty("transcript");
    await fetch(`http://127.0.0.1:${port}/v1/stop?session=s1`, {
      method: "POST",
      headers: authHeaders(token),
    });
    expect(appended).toEqual([]);
    expect(finalized).toEqual([]);
  });
});
