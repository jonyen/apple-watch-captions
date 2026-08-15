import { describe, it, expect, afterEach } from "vitest";
import { AddressInfo } from "net";
import { createHash } from "crypto";
import WebSocket from "ws";
import { startServer, CaptionServer } from "./server";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";
import { IdentityStore } from "./identityStore";
import { openDb, Db } from "./db";

let running: CaptionServer | null = null;

afterEach(async () => {
  if (running) await running.close();
  running = null;
});

function start(callForwardTo?: string) {
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
    callForwardTo,
  });
  running = server;
  return { providers, port: (server.address() as AddressInfo).port, token: device.token };
}

/**
 * Twilio's own client does not honor `IdentityStore`'s random-token
 * generation — this test needs one specific string as a device's token, so
 * it plants it directly, hashed the same way `IdentityStore` hashes every
 * token it stores.
 */
function withToken(db: Db, identity: IdentityStore, token: string): void {
  const device = identity.registerDevice("watch");
  db.prepare("UPDATE devices SET token_hash = ? WHERE id = ?")
    .run(createHash("sha256").update(token).digest("hex"), device.deviceId);
}

const base = (port: number) => `http://127.0.0.1:${port}`;

describe("POST /twilio/voice", () => {
  it("returns TwiML pointing the stream at this relay", async () => {
    const { port, token } = start("+15551234567");

    const res = await fetch(`${base(port)}/twilio/voice?token=${token}`, { method: "POST" });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/xml");
    const xml = await res.text();
    // Token in the path: Twilio's stream client discards the query string.
    expect(xml).toContain(`wss://127.0.0.1:${port}/twilio/stream/${token}`);
    expect(xml).toContain('track="inbound_track"');
    expect(xml).toContain("<Dial>+15551234567</Dial>");
  });

  it("rejects a request without a valid token", async () => {
    const { port } = start("+15551234567");
    expect((await fetch(`${base(port)}/twilio/voice`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${base(port)}/twilio/voice?token=bad`, { method: "POST" })).status)
      .toBe(401);
  });

  // Better to refuse than to answer with TwiML that dials nowhere.
  it("503s when no forwarding number is configured", async () => {
    const { port, token } = start(undefined);
    const res = await fetch(`${base(port)}/twilio/voice?token=${token}`, { method: "POST" });
    expect(res.status).toBe(503);
  });
});

describe("GET /v1/call", () => {
  it("reports no call when none is live", async () => {
    const { port, token } = start("+15551234567");

    const res = await fetch(`${base(port)}/v1/call?token=${token}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ active: false, events: [], seq: 0 });
  });

  it("rejects a poll without a valid token", async () => {
    const { port } = start("+15551234567");
    expect((await fetch(`${base(port)}/v1/call`)).status).toBe(401);
    expect((await fetch(`${base(port)}/v1/call?token=bad`)).status).toBe(401);
  });

  // Twilio's media-stream client discards the query string — a live call
  // reached the relay as a bare `/twilio/stream` with no token, so the relay
  // rejected it and Twilio reported "server closed the connection". The token
  // travels in the path because that is what actually survives.
  it("accepts a stream whose token is in the path, as Twilio sends it", async () => {
    const { providers, port, token } = start("+15551234567");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/twilio/stream/${token}`);
    await new Promise((resolve) => ws.on("open", resolve));

    ws.send(JSON.stringify({
      event: "start",
      streamSid: "MZpath",
      start: { callSid: "CApath", streamSid: "MZpath" },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    providers[0].emitReady();

    const body = await (await fetch(`${base(port)}/v1/call?token=${token}`)).json();

    expect(body.active).toBe(true);
    ws.close();
  });

  it("rejects a stream whose path token is wrong", async () => {
    const { port } = start("+15551234567");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/twilio/stream/nope`);
    const code = await new Promise((resolve) => ws.on("close", resolve));

    expect(code).toBe(4001);
  });

  it("serves captions from the live call", async () => {
    const { providers, port, token } = start("+15551234567");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/twilio/stream?token=${token}`);
    await new Promise((resolve) => ws.on("open", resolve));

    ws.send(JSON.stringify({
      event: "start",
      streamSid: "MZ1",
      start: { callSid: "CA1", streamSid: "MZ1" },
    }));
    // Give the server a tick to process the frame and create the session.
    await new Promise((resolve) => setTimeout(resolve, 50));
    providers[0].emitReady();
    providers[0].emitTranscript({ text: "hello there", isFinal: true });

    const body = await (await fetch(`${base(port)}/v1/call?token=${token}`)).json();

    expect(body.active).toBe(true);
    expect(body.events.some((e: any) => e.type === "caption" && e.text === "hello there"))
      .toBe(true);
    ws.close();
  });

  // reapIdle (and a direct /v1/stop) can drop the SessionStore session
  // without telling CurrentCall. Without the guard in GET /v1/call, this
  // would report `active: true` forever with no captions ever arriving —
  // simulate it here by stopping the session out from under CurrentCall and
  // confirming the endpoint notices instead of hanging.
  it("reports no call when its session has been reaped out from under CurrentCall", async () => {
    const { port, token } = start("+15551234567");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/twilio/stream?token=${token}`);
    await new Promise((resolve) => ws.on("open", resolve));

    ws.send(JSON.stringify({
      event: "start",
      streamSid: "MZ1",
      start: { callSid: "CA1", streamSid: "MZ1" },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Drop the session directly, bypassing the normal end-of-call path so
    // CurrentCall still believes CA1 is live.
    await fetch(`${base(port)}/v1/stop?token=${token}&session=CA1`, { method: "POST" });

    const body = await (await fetch(`${base(port)}/v1/call?token=${token}`)).json();
    // The call itself may still be live — only its captions died — so this
    // is stream_lost, not ended. Reporting "ended" would tell the watch the
    // call is over while the user may still be talking.
    expect(body).toEqual({ active: false, reason: "stream_lost", events: [], seq: 0 });
    ws.close();
  });
});

describe("POST /twilio/voice with a token containing XML metacharacters", () => {
  // escapeXml(streamUrl) in twiml.ts is dead code on this path — the query
  // string is already encodeURIComponent'd before voiceResponse ever sees
  // it, so the safety here rests entirely on that encode surviving future
  // edits. Pin the whole composition at the route, not just the XML half in
  // isolation (that's twiml.test.ts).
  it("keeps the emitted TwiML well-formed", async () => {
    const token = 'a&b<c>d"e';
    const db = openDb(":memory:");
    const identity = new IdentityStore(db);
    withToken(db, identity, token);
    const providers: FakeTranscriptionProvider[] = [];
    const server = startServer({
      port: 0,
      identity,
      createProvider: () => {
        const p = new FakeTranscriptionProvider();
        providers.push(p);
        return p;
      },
      callForwardTo: "+15551234567",
    });
    running = server;
    const port = (server.address() as AddressInfo).port;

    const res = await fetch(
      `${base(port)}/twilio/voice?token=${encodeURIComponent(token)}`,
      { method: "POST" });

    expect(res.status).toBe(200);
    const xml = await res.text();

    // The token round-trips into a stream URL Twilio can still use.
    expect(xml).toContain(
      `wss://127.0.0.1:${port}/twilio/stream/${encodeURIComponent(token)}`);

    // No raw metacharacter from the token leaked into the URL attribute
    // itself (as opposed to appearing percent-encoded).
    const streamUrl = xml.match(/<Stream url="([^"]*)"/)?.[1];
    expect(streamUrl).toBeTruthy();
    expect(streamUrl).not.toMatch(/[&<>"]/);

    // And the document is well-formed: every ampersand that survived is
    // part of a real entity reference, never a bare one that would make
    // Twilio's XML parser reject the whole document.
    expect(xml.match(/&(?!amp;|lt;|gt;|quot;|apos;)/g)).toBeNull();

    expect(xml).toContain("<Response>");
    expect(xml).toContain("</Response>");
    expect(xml).toContain("<Dial>+15551234567</Dial>");
  });
});
