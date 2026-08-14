import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { startServer, CaptionServer } from "./server";
import { IdentityStore } from "./identityStore";
import { openDb } from "./db";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";

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
});
