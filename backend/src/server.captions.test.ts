import { describe, it, expect, afterEach, vi } from "vitest";
import { AddressInfo } from "net";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { startServer, CaptionServer } from "./server";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";
import { TranscriptStore } from "./transcriptStore";
import { IdentityStore } from "./identityStore";
import { openDb } from "./db";

// POST /v1/captions — the HTTP mirror of /stream's `{"caption":…}` frames,
// for the watch, which cannot open a WebSocket (TN3135; the same reason
// /v1/audio exists). Same bearer auth, same client-chosen `session` id, same
// lifecycle (created lazily on first post, finalized by /v1/stop or the idle
// reaper) — but no transcription provider is ever opened for a caption-only
// session, since there is no audio to transcribe.

let running: CaptionServer | null = null;
let tmp: string | null = null;

afterEach(async () => {
  if (running) await running.close();
  running = null;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

function authHeaders(token: string) {
  return { authorization: `Bearer ${token}` };
}

/** A server with a real TranscriptStore on disk and capturable fake providers. */
function startWithTranscripts() {
  tmp = mkdtempSync(join(tmpdir(), "transcripts-captions-"));
  const identity = new IdentityStore(openDb(":memory:"));
  const device = identity.registerDevice("watch");
  const providers: FakeTranscriptionProvider[] = [];
  const transcripts = new TranscriptStore({ root: tmp });
  const server = startServer({
    port: 0,
    identity,
    createProvider: () => {
      const p = new FakeTranscriptionProvider();
      providers.push(p);
      return p;
    },
    transcripts,
    transcriptsRoot: tmp,
  });
  running = server;
  const port = (server.address() as AddressInfo).port;
  return { providers, transcripts, port, token: device.token, userId: device.userId };
}

const captionsURL = (port: number, query: string) =>
  `http://127.0.0.1:${port}/v1/captions?${query}`;

function post(url: string, token: string, body: unknown) {
  return fetch(url, {
    method: "POST",
    headers: { ...authHeaders(token), "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /v1/captions", () => {
  it("rejects a post with no token", async () => {
    const { port } = startWithTranscripts();
    const res = await fetch(captionsURL(port, "session=s1"), {
      method: "POST",
      body: JSON.stringify({ lines: [{ text: "hi", isFinal: true }] }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a post with a bad token", async () => {
    const { port } = startWithTranscripts();
    const res = await post(captionsURL(port, "session=s1"), "wrong", {
      lines: [{ text: "hi", isFinal: true }],
    });
    expect(res.status).toBe(401);
  });

  it("rejects a post with no session", async () => {
    const { port, token } = startWithTranscripts();
    const res = await post(captionsURL(port, ""), token, {
      lines: [{ text: "hi", isFinal: true }],
    });
    expect(res.status).toBe(400);
  });

  it("stores lines, names the transcript, reaches a polling viewer, and opens no provider", async () => {
    const { providers, port, token } = startWithTranscripts();

    const res = await post(captionsURL(port, "session=cap1&since=0"), token, {
      lines: [
        { text: "hello", isFinal: false },
        { text: "hello world", isFinal: true },
      ],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Both lines echo back as caption events, like the audio path's response.
    expect(body.events).toEqual([
      { seq: 1, type: "caption", text: "hello", isFinal: false },
      { seq: 2, type: "caption", text: "hello world", isFinal: true },
    ]);
    expect(body.seq).toBe(2);
    // The first final created the transcript, and the response names it so
    // the client can offer to resume it later — same contract as /v1/audio.
    expect(body.transcript).toMatch(/_cap1$/);

    // A viewer polls the same session the way the watch reads the phone's
    // audio session: an empty-body /v1/audio post. The injected lines reach
    // it through the same event buffer a provider caption would.
    const view = await fetch(`http://127.0.0.1:${port}/v1/audio?session=cap1&since=0`, {
      method: "POST",
      headers: authHeaders(token),
      body: new Uint8Array(0),
    });
    const seen = await view.json();
    expect(seen.events).toEqual([
      { seq: 1, type: "caption", text: "hello", isFinal: false },
      { seq: 2, type: "caption", text: "hello world", isFinal: true },
    ]);

    // Caption-only for its whole life: no transcription provider was opened.
    expect(providers).toHaveLength(0);
  });

  it("persists only finals and shows the transcript in history after /v1/stop", async () => {
    const { port, token } = startWithTranscripts();

    await post(captionsURL(port, "session=cap1"), token, {
      lines: [
        { text: "partial repaint", isFinal: false },
        { text: "first line.", isFinal: true },
      ],
    });
    await post(captionsURL(port, "session=cap1"), token, {
      lines: [{ text: "second line.", isFinal: true }],
    });
    await fetch(`http://127.0.0.1:${port}/v1/stop?session=cap1`, {
      method: "POST",
      headers: authHeaders(token),
    });

    const res = await fetch(`http://127.0.0.1:${port}/v1/transcripts`, {
      headers: authHeaders(token),
    });
    const { transcripts } = await res.json();
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0].name).toMatch(/_cap1$/);
    expect(transcripts[0].segmentCount).toBe(2); // finals only, no repaints
  });

  it("finalizes exactly once on stop, like an audio session", async () => {
    const { transcripts, port, token } = startWithTranscripts();
    const finalize = vi.spyOn(transcripts, "finalize");

    await post(captionsURL(port, "session=cap1"), token, {
      lines: [{ text: "kept on device.", isFinal: true }],
    });
    await fetch(`http://127.0.0.1:${port}/v1/stop?session=cap1`, {
      method: "POST",
      headers: authHeaders(token),
    });
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledWith(expect.any(String), "cap1");

    // A second stop finds no session and must not finalize again.
    await fetch(`http://127.0.0.1:${port}/v1/stop?session=cap1`, {
      method: "POST",
      headers: authHeaders(token),
    });
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it("allows an empty batch to establish the session before any final names it", async () => {
    const { port, token } = startWithTranscripts();

    const first = await post(captionsURL(port, "session=cap1"), token, { lines: [] });
    expect(first.status).toBe(200);
    expect(await first.json()).not.toHaveProperty("transcript");

    const second = await post(captionsURL(port, "session=cap1"), token, {
      lines: [{ text: "now it exists.", isFinal: true }],
    });
    expect((await second.json()).transcript).toMatch(/_cap1$/);
  });

  it("rejects malformed bodies with 400 without creating or killing a session", async () => {
    const { providers, port, token } = startWithTranscripts();

    // A well-formed line first, so there is a live session to fail to kill.
    await post(captionsURL(port, "session=cap1"), token, {
      lines: [{ text: "first.", isFinal: true }],
    });

    const malformed = [
      "{not json",
      JSON.stringify({}),
      JSON.stringify({ lines: "nope" }),
      JSON.stringify({ lines: [{ isFinal: true }] }),
      JSON.stringify({ lines: [{ text: 42, isFinal: true }] }),
      JSON.stringify({ lines: [{ text: "x", isFinal: "yes" }] }),
      JSON.stringify({ lines: ["just a string"] }),
    ];
    for (const body of malformed) {
      const res = await post(captionsURL(port, "session=cap1"), token, body);
      expect(res.status).toBe(400);
      const fresh = await post(captionsURL(port, "session=never-created"), token, body);
      expect(fresh.status).toBe(400);
    }

    // The existing session took no damage: the next line lands after the
    // first, and the malformed session id was never created at all.
    const ok = await post(captionsURL(port, "session=cap1&since=1"), token, {
      lines: [{ text: "second.", isFinal: true }],
    });
    const body = await ok.json();
    expect(body.events).toEqual([
      { seq: 2, type: "caption", text: "second.", isFinal: true },
    ]);
    const list = await fetch(`http://127.0.0.1:${port}/v1/transcripts`, {
      headers: authHeaders(token),
    });
    expect((await list.json()).transcripts).toHaveLength(1);
    expect(providers).toHaveLength(0);
  });

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
        activeName: () => undefined,
      } as any,
    });
    running = server;
    const port = (server.address() as AddressInfo).port;
    const url = captionsURL(port, "session=s1&resume=2026-07-06T01-02-03Z_abc");

    await post(url, device.token, { lines: [{ text: "more.", isFinal: true }] });
    expect(reopened).toEqual([["s1", "2026-07-06T01-02-03Z_abc"]]);

    // Only before the session exists — a later post must not re-bind.
    await post(url, device.token, { lines: [{ text: "and more.", isFinal: true }] });
    expect(reopened).toHaveLength(1);
  });
});
