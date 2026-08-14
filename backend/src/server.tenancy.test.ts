import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { startServer, CaptionServer } from "./server";
import { IdentityStore } from "./identityStore";
import { openDb } from "./db";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";
import { TranscriptStore, listTranscripts, userDir } from "./transcriptStore";

let server: CaptionServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("cross-tenant isolation", () => {
  it("does not let one user poll another user's session", async () => {
    const identity = new IdentityStore(openDb(":memory:"));
    const alice = identity.registerDevice("watch");
    const mallory = identity.registerDevice("watch");
    const providers: FakeTranscriptionProvider[] = [];
    server = startServer({
      port: 0,
      identity,
      createProvider: () => {
        const p = new FakeTranscriptionProvider();
        providers.push(p);
        return p;
      },
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    await fetch(`http://127.0.0.1:${port}/v1/audio?session=shared-id`, {
      method: "POST",
      headers: { authorization: `Bearer ${alice.token}` },
      body: Buffer.alloc(3200),
    });
    // A real event, driven explicitly — FakeTranscriptionProvider emits
    // nothing on its own, so the `[]` assertion below would pass whether or
    // not isolation actually holds unless something was really emitted into
    // Alice's session first.
    providers[0].emitTranscript({ text: "secret", isFinal: true });

    const res = await fetch(`http://127.0.0.1:${port}/v1/audio?session=shared-id`, {
      method: "POST",
      headers: { authorization: `Bearer ${mallory.token}` },
      body: Buffer.alloc(0),
    });
    const body = (await res.json()) as { events: { type: string; text?: string }[]; seq: number };
    expect(body.events).toEqual([]);
    expect(body.seq).toBe(0);

    // And Alice must still see her own caption — proving this is isolation,
    // not just everything being broken.
    const aliceRes = await fetch(`http://127.0.0.1:${port}/v1/audio?session=shared-id`, {
      method: "POST",
      headers: { authorization: `Bearer ${alice.token}` },
      body: Buffer.alloc(0),
    });
    const aliceBody = (await aliceRes.json()) as {
      events: { type: string; text?: string }[];
      seq: number;
    };
    expect(aliceBody.events.some((e) => e.type === "caption" && e.text === "secret")).toBe(true);
  });

  it("does not let one user see or drain another user's Twilio call", async () => {
    const identity = new IdentityStore(openDb(":memory:"));
    const alice = identity.registerDevice("watch");
    const mallory = identity.registerDevice("watch");
    const providers: FakeTranscriptionProvider[] = [];
    server = startServer({
      port: 0,
      identity,
      createProvider: () => {
        const p = new FakeTranscriptionProvider();
        providers.push(p);
        return p;
      },
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    // Alice's device authorises the Twilio media-stream WebSocket — the call
    // belongs to her.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/twilio/stream?token=${alice.token}`);
    await new Promise((resolve) => ws.on("open", resolve));
    ws.send(JSON.stringify({
      event: "start",
      streamSid: "MZ1",
      start: { callSid: "CA1", streamSid: "MZ1" },
    }));
    // Give the server a tick to process the frame and create the session.
    await new Promise((resolve) => setTimeout(resolve, 50));
    providers[0].emitReady();
    providers[0].emitTranscript({ text: "alice's secret", isFinal: true });

    // Mallory polls with her own valid token and a large `since` — the exact
    // shape that, before the fix, adopted the call's owner as the
    // SessionStore key and pruned the owner's undelivered buffer as a side
    // effect of a stranger's read.
    const malloryRes = await fetch(
      `http://127.0.0.1:${port}/v1/call?token=${mallory.token}&since=999999`,
    );
    expect(malloryRes.status).toBe(200);
    const malloryBody = await malloryRes.json();
    // Exactly this shape: no `reason` key leaking whether/why someone else's
    // call ended, no events, `seq` echoing back what Mallory sent.
    expect(malloryBody).toEqual({ active: false, events: [], seq: 999999 });

    // Alice must still receive her pending caption — Mallory's poll must not
    // have emptied it.
    const aliceRes = await fetch(`http://127.0.0.1:${port}/v1/call?token=${alice.token}`);
    const aliceBody = (await aliceRes.json()) as {
      active: boolean;
      events: { type: string; text?: string }[];
    };
    expect(aliceBody.active).toBe(true);
    expect(
      aliceBody.events.some((e) => e.type === "caption" && e.text === "alice's secret"),
    ).toBe(true);

    ws.close();
  });

  it("does not leak whether or how another user's call ended", async () => {
    const identity = new IdentityStore(openDb(":memory:"));
    const alice = identity.registerDevice("watch");
    const mallory = identity.registerDevice("watch");
    server = startServer({
      port: 0,
      identity,
      createProvider: () => new FakeTranscriptionProvider(),
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    // Alice's call begins and ends. CurrentCall is process-global, so its
    // `lastReason()` must not answer it for anyone but Alice.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/twilio/stream?token=${alice.token}`);
    await new Promise((resolve) => ws.on("open", resolve));
    ws.send(JSON.stringify({
      event: "start",
      streamSid: "MZ1",
      start: { callSid: "CA1", streamSid: "MZ1" },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    ws.send(JSON.stringify({ event: "stop" }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Mallory, polling with her own valid token, must get exactly the
    // no-call-active shape — no `reason` key at all, and `seq` echoing back
    // what she sent. `toEqual` on the whole object so an extra key fails.
    const malloryRes = await fetch(
      `http://127.0.0.1:${port}/v1/call?token=${mallory.token}&since=42`,
    );
    expect(malloryRes.status).toBe(200);
    const malloryBody = await malloryRes.json();
    expect(malloryBody).toEqual({ active: false, events: [], seq: 42 });

    // Alice, the call's actual owner, must still learn how her own call
    // ended — this is what stops the fix from degenerating into "never
    // report a reason to anyone".
    const aliceRes = await fetch(`http://127.0.0.1:${port}/v1/call?token=${alice.token}`);
    const aliceBody = await aliceRes.json();
    expect(aliceBody).toEqual({ active: false, reason: "ended", events: [], seq: 0 });
  });

  it("does not list another user's transcripts", async () => {
    const root = mkdtempSync(join(tmpdir(), "wc-"));
    const identity = new IdentityStore(openDb(":memory:"));
    const alice = identity.registerDevice("watch");
    const mallory = identity.registerDevice("watch");
    const transcripts = new TranscriptStore({ root });
    transcripts.append(
      identity.resolve(alice.token)!.userId,
      "s1",
      "alice's private conversation",
    );

    server = startServer({
      port: 0,
      identity,
      createProvider: () => new FakeTranscriptionProvider(),
      transcripts,
      transcriptsRoot: root,
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    const res = await fetch(`http://127.0.0.1:${port}/v1/transcripts`, {
      headers: { authorization: `Bearer ${mallory.token}` },
    });
    expect((await res.json()) as { transcripts: unknown[] }).toEqual({ transcripts: [] });

    // And Alice must still see her own transcript — proving this is
    // isolation, not just everything being broken.
    const aliceRes = await fetch(`http://127.0.0.1:${port}/v1/transcripts`, {
      headers: { authorization: `Bearer ${alice.token}` },
    });
    const aliceBody = (await aliceRes.json()) as { transcripts: { preview: string }[] };
    expect(aliceBody.transcripts).toHaveLength(1);
    expect(aliceBody.transcripts[0].preview).toBe("alice's private conversation");
  });

  it("does not report one user's presence as another's", async () => {
    const identity = new IdentityStore(openDb(":memory:"));
    const alice = identity.registerDevice("watch");
    const mallory = identity.registerDevice("watch");
    server = startServer({
      port: 0,
      identity,
      createProvider: () => new FakeTranscriptionProvider(),
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    // Alice marks herself present as both reader and producer on a session id
    // Mallory also knows, since ids are client-chosen and not secret.
    await fetch(`http://127.0.0.1:${port}/v1/audio?session=shared-id&role=reader&ephemeral=1`, {
      method: "POST",
      headers: { authorization: `Bearer ${alice.token}` },
      body: Buffer.alloc(320),
    });

    const malloryRes = await fetch(
      `http://127.0.0.1:${port}/v1/presence?session=shared-id`,
      { headers: { authorization: `Bearer ${mallory.token}` } },
    );
    expect(await malloryRes.json()).toEqual({ reader: false, producer: false });

    // And Alice must still see her own presence — proving this is isolation,
    // not just everything being broken.
    const aliceRes = await fetch(
      `http://127.0.0.1:${port}/v1/presence?session=shared-id`,
      { headers: { authorization: `Bearer ${alice.token}` } },
    );
    expect(await aliceRes.json()).toEqual({ reader: true, producer: true });
  });

  // The tests above append directly through TranscriptStore or check
  // isolation at a single route; none of them drive a caption all the way
  // from a live session through SessionStore into TranscriptStore and check
  // where it actually lands on disk. That gap would miss a regression where
  // any of SessionStore's four transcript call sites, or the legacy /stream
  // WebSocket path, passed the wrong id where userId belongs — silently
  // misattributing (or leaking) a transcript with no test failing.
  it("writes a live session's transcript under the streaming user's own directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "wc-"));
    const identity = new IdentityStore(openDb(":memory:"));
    const alice = identity.registerDevice("watch");
    const mallory = identity.registerDevice("watch");
    const providers: FakeTranscriptionProvider[] = [];
    const transcripts = new TranscriptStore({ root });
    server = startServer({
      port: 0,
      identity,
      createProvider: () => {
        const p = new FakeTranscriptionProvider();
        providers.push(p);
        return p;
      },
      transcripts,
      transcriptsRoot: root,
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    // The real production path: stream audio as Alice, drive a final caption
    // through the fake provider, then stop the session — not a direct
    // `store.append()` call.
    await fetch(`http://127.0.0.1:${port}/v1/audio?session=s1`, {
      method: "POST",
      headers: { authorization: `Bearer ${alice.token}` },
      body: Buffer.alloc(3200),
    });
    providers[0].emitTranscript({ text: "alice's real session", isFinal: true });
    await fetch(`http://127.0.0.1:${port}/v1/stop?session=s1`, {
      method: "POST",
      headers: { authorization: `Bearer ${alice.token}` },
    });

    expect(listTranscripts(userDir(root, mallory.userId))).toEqual([]);
    const aliceTranscripts = listTranscripts(userDir(root, alice.userId));
    expect(aliceTranscripts).toHaveLength(1);
    expect(aliceTranscripts[0].preview).toBe("alice's real session");
  });
});
