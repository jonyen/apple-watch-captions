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

  // The eviction half of the same question the test above asks about reads:
  // a `start` frame ends "the current call" before beginning its own. With a
  // single process-global call slot, that eviction hit whoever held it —
  // so any self-registered device could close a stranger's live call and
  // take the slot, and the victim's next poll answered "no call".
  it("does not let one user's incoming call end another user's live call", async () => {
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

    // Alice's call is live.
    const aliceWs = new WebSocket(`ws://127.0.0.1:${port}/twilio/stream?token=${alice.token}`);
    await new Promise((resolve) => aliceWs.on("open", resolve));
    aliceWs.send(JSON.stringify({
      event: "start",
      streamSid: "MZ-alice",
      start: { callSid: "CA-alice", streamSid: "MZ-alice" },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    providers[0].emitReady();

    // Mallory opens her own media stream with her own valid token and starts
    // a call of her own.
    const malloryWs = new WebSocket(`ws://127.0.0.1:${port}/twilio/stream?token=${mallory.token}`);
    await new Promise((resolve) => malloryWs.on("open", resolve));
    malloryWs.send(JSON.stringify({
      event: "start",
      streamSid: "MZ-mallory",
      start: { callSid: "CA-mallory", streamSid: "MZ-mallory" },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Alice's session is still live and still hers: a caption emitted into it
    // after Mallory's start frame still reaches Alice.
    providers[0].emitTranscript({ text: "still talking", isFinal: true });
    const aliceRes = await fetch(`http://127.0.0.1:${port}/v1/call?token=${alice.token}`);
    const aliceBody = (await aliceRes.json()) as {
      active: boolean;
      reason?: string;
      events: { type: string; text?: string }[];
    };
    expect(aliceBody.active).toBe(true);
    expect(aliceBody.reason).toBeUndefined();
    expect(
      aliceBody.events.some((e) => e.type === "caption" && e.text === "still talking"),
    ).toBe(true);

    // And Mallory's own call is genuinely live too — this is two calls at
    // once, not Mallory's start frame having been dropped on the floor.
    const malloryBody = await (
      await fetch(`http://127.0.0.1:${port}/v1/call?token=${mallory.token}`)
    ).json();
    expect(malloryBody.active).toBe(true);

    aliceWs.close();
    malloryWs.close();
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

// The two-way half of the same property. Presence decides where an inbound
// call goes; the downlink is the caller's voice, played into the room; the
// uplink speaks into the call; end hangs it up. Every one of these was a
// process-global on the old lineage, and registration is open — so each test
// below is a real attack any self-registered device could have run, scripted
// from the Task 1 spike's walk. Each also carries a positive control (the
// owner's own path still works), so a pass means isolation, not breakage.
describe("cross-tenant isolation for two-way call audio", () => {
  function startTwoUsers() {
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
      callForwardTo: "+15551234567",
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    return { alice, mallory, providers, port };
  }

  /** Open a live two-way call for whoever owns `token`. */
  async function liveCall(port: number, token: string, callSid: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/twilio/stream/${token}`);
    await new Promise((resolve) => ws.on("open", resolve));
    ws.send(JSON.stringify({
      event: "start",
      streamSid: `MZ-${callSid}`,
      start: { callSid, streamSid: `MZ-${callSid}` },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    return ws;
  }

  // Attack 1: presence. Mallory's watch says "ready"; Alice's number rings.
  // With one shared presence scalar, Alice's webhook would see "a watch is
  // ready" and serve <Connect> — handing Alice's caller to whichever stream
  // the TwiML names while Alice's own watch is dark.
  it("does not let one user's ready watch arm another user's inbound call", async () => {
    const { alice, mallory, port } = startTwoUsers();

    // Mallory marks presence with her own, valid token.
    await fetch(`http://127.0.0.1:${port}/v1/call?token=${mallory.token}&ready=1`);

    // Alice's inbound call — her webhook token resolves to her principal —
    // must consult Alice's presence only: her watch is dark, so the caller
    // hears ringback, and <Connect> is never armed.
    const xml = await (
      await fetch(`http://127.0.0.1:${port}/twilio/voice?token=${alice.token}`, {
        method: "POST",
      })
    ).text();
    expect(xml).not.toContain("<Connect>");
    expect(xml).toContain("ringback.wav");

    // Positive control: when Alice's own watch is ready, her call connects —
    // proving the refusal above was isolation, not ringback-for-everyone.
    await fetch(`http://127.0.0.1:${port}/v1/call?token=${alice.token}&ready=1`);
    const readyXml = await (
      await fetch(`http://127.0.0.1:${port}/twilio/voice?token=${alice.token}`, {
        method: "POST",
      })
    ).text();
    expect(readyXml).toContain("<Connect>");
  });

  // Attack 2: the downlink. With one shared buffer, Mallory's poll would be
  // handed Alice's caller's voice. Draining her own (empty) buffer must not
  // read Alice's bytes, and — since `drain` only filters by cursor and never
  // removes entries — Alice's watch must still be able to read them
  // afterward, unconsumed by Mallory's poll.
  it("does not let one user drain another user's caller audio", async () => {
    const { alice, mallory, port } = startTwoUsers();
    const ws = await liveCall(port, alice.token, "CA-alice");
    ws.send(JSON.stringify({
      event: "media",
      media: { payload: Buffer.from([0xff, 0xfe]).toString("base64") },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Mallory polls with her own valid token: she gets her own (empty)
    // compartment, not Alice's audio.
    const malloryRes = await fetch(
      `http://127.0.0.1:${port}/v1/call/audio?token=${mallory.token}&since=0`,
    );
    expect(malloryRes.status).toBe(200);
    expect((await malloryRes.arrayBuffer()).byteLength).toBe(0);
    expect(malloryRes.headers.get("x-seq")).toBe("0");

    // And Alice's audio is still waiting for Alice — Mallory's poll neither
    // read it nor consumed it.
    const aliceRes = await fetch(
      `http://127.0.0.1:${port}/v1/call/audio?token=${alice.token}&since=0`,
    );
    expect([...Buffer.from(await aliceRes.arrayBuffer())]).toEqual([0xff, 0xfe]);
    ws.close();
  });

  // Attack 3: the uplink. With one shared sender, Mallory's POST would be
  // spoken into Alice's live call, in Alice's caller's ear.
  it("does not let one user speak into another user's call", async () => {
    const { alice, mallory, port } = startTwoUsers();
    const ws = await liveCall(port, alice.token, "CA-alice");
    const framesToAlice: any[] = [];
    ws.on("message", (data: Buffer) => framesToAlice.push(JSON.parse(data.toString())));

    // Mallory has no live call, so her audio has nowhere hers to go: 409,
    // never a write into someone else's socket.
    const malloryRes = await fetch(`http://127.0.0.1:${port}/v1/call/audio?token=${mallory.token}`, {
      method: "POST",
      body: Buffer.alloc(800),
    });
    expect(malloryRes.status).toBe(409);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(framesToAlice.filter((f) => f.event === "media")).toHaveLength(0);

    // Positive control: Alice's own voice does reach her call's socket.
    const aliceRes = await fetch(`http://127.0.0.1:${port}/v1/call/audio?token=${alice.token}`, {
      method: "POST",
      body: Buffer.alloc(800),
    });
    expect(aliceRes.status).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(framesToAlice.filter((f) => f.event === "media")).toHaveLength(1);
    ws.close();
  });

  // Attack 4: the hangup handle. Under <Connect><Stream> closing the socket
  // IS the hangup — with one shared closer, Mallory's POST would disconnect
  // Alice mid-sentence, and the base's own CurrentCall comment names this
  // exact attack for the eviction path.
  it("does not let one user end another user's call", async () => {
    const { alice, mallory, port } = startTwoUsers();
    const ws = await liveCall(port, alice.token, "CA-alice");
    let aliceSocketClosed = false;
    ws.on("close", () => {
      aliceSocketClosed = true;
    });

    const malloryRes = await fetch(`http://127.0.0.1:${port}/v1/call/end?token=${mallory.token}`, {
      method: "POST",
    });
    expect(malloryRes.status).toBe(409);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(aliceSocketClosed).toBe(false);
    const aliceBody = await (
      await fetch(`http://127.0.0.1:${port}/v1/call?token=${alice.token}`)
    ).json();
    expect(aliceBody.active).toBe(true);

    // Positive control: Alice can end her own call, which closes the socket.
    const aliceRes = await fetch(`http://127.0.0.1:${port}/v1/call/end?token=${alice.token}`, {
      method: "POST",
    });
    expect(aliceRes.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(aliceSocketClosed).toBe(true);
  });
});
