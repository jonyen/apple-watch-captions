import { describe, it, expect, afterEach, vi } from "vitest";
import { randomBytes } from "crypto";
import { startServer, CaptionServer, StartServerOptions } from "./server";
import { openDb } from "./db";
import { IdentityStore } from "./identityStore";
import {
  ExportDestinationStore,
  adoptLegacyNotion,
  adoptLegacyNotionAtBoot,
  adoptLegacyNotionIfUnambiguous,
} from "./exportDestinations";
import { OAuthStateStore } from "./notionOAuth";
import { EmailVerificationStore } from "./emailVerification";
import { SendEmailArgs } from "./emailSender";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";

let server: CaptionServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const notionOAuth = {
  clientId: "client-1",
  clientSecret: "shhh",
  redirectUri: "https://relay.example/v1/exports/notion/callback",
};

function start(overrides: Partial<StartServerOptions> = {}) {
  const db = openDb(":memory:");
  const identity = new IdentityStore(db);
  const destinations = new ExportDestinationStore(db, randomBytes(32));
  const oauthStates = new OAuthStateStore(db);
  const emailVerifications = new EmailVerificationStore(db);
  const sentEmails: SendEmailArgs[] = [];
  const sendEmail = async (args: SendEmailArgs) => {
    sentEmails.push(args);
  };
  const alice = identity.registerDevice("phone");
  const mallory = identity.registerDevice("phone");
  server = startServer({
    port: 0,
    identity,
    destinations,
    oauthStates,
    notionOAuth,
    emailVerifications,
    sendEmail,
    publicBaseUrl: "https://relay.example",
    exchangeNotionCode: async (code) => {
      if (code !== "good-code") throw new Error("bad code");
      return { accessToken: "ntn_granted", databaseId: "db1", workspaceName: "Alice's Notes" };
    },
    createProvider: () => new FakeTranscriptionProvider(),
    ...overrides,
  });
  const addr = server.address();
  return {
    port: typeof addr === "object" && addr ? addr.port : 0,
    destinations,
    oauthStates,
    emailVerifications,
    sentEmails,
    alice,
    mallory,
  };
}

describe("GET /app/exports", () => {
  it("serves the export destinations page", async () => {
    const { port } = start();
    const res = await fetch(`http://127.0.0.1:${port}/app/exports`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const body = await res.text();
    expect(body).toContain("Connect Notion");
    // A revoked connection renders a "needs reconnect" badge. Without a
    // reconnect affordance on that same row the badge is a dead end — the
    // only button there is Disconnect, so the page would tell the user to do
    // something it gives them no way to do. Text-level, matching the other
    // assertions on this page.
    expect(body).toContain("Reconnect");
    // Fix round 1, Minor 2: the Connect link carries the device token in its
    // URL (the one place in the app that happens) — `rel="noreferrer"` stops
    // the browser from leaking this page's URL as a Referer on the
    // navigation the link starts.
    expect(body).toMatch(/connect\.rel\s*=\s*['"]noreferrer['"]/);
  });
});

describe("GET /v1/exports", () => {
  it("requires authentication", async () => {
    const { port } = start();
    expect((await fetch(`http://127.0.0.1:${port}/v1/exports`)).status).toBe(401);
  });

  it("lists only the caller's own destinations", async () => {
    const { port, destinations, alice, mallory } = start();
    destinations.putNotion(alice.userId, "ntn_secret", {
      databaseId: "db1",
      workspaceName: "Alice's Notes",
    });

    const mine = await fetch(`http://127.0.0.1:${port}/v1/exports`, {
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(await mine.json()).toEqual({
      destinations: [{ kind: "notion", connected: true, detail: "Alice's Notes" }],
    });

    const theirs = await fetch(`http://127.0.0.1:${port}/v1/exports`, {
      headers: { authorization: `Bearer ${mallory.token}` },
    });
    expect(await theirs.json()).toEqual({ destinations: [] });
  });

  it("never returns a secret", async () => {
    const { port, destinations, alice } = start();
    destinations.putNotion(alice.userId, "ntn_secret", { databaseId: "db1" });
    const res = await fetch(`http://127.0.0.1:${port}/v1/exports`, {
      headers: { authorization: `Bearer ${alice.token}` },
    });
    // Asserting only "the body doesn't contain the secret" passes on any
    // 401/404/500 too, so it can't actually fail. Pin the response to an
    // actual successful listing first.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      destinations: [{ kind: "notion", connected: true, detail: "db1" }],
    });
    expect(JSON.stringify(body)).not.toContain("ntn_secret");
  });
});

describe("GET /v1/exports/notion/start", () => {
  it("redirects to Notion carrying a state", async () => {
    const { port, alice } = start();
    const res = await fetch(`http://127.0.0.1:${port}/v1/exports/notion/start`, {
      headers: { authorization: `Bearer ${alice.token}` },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://api.notion.com/v1/oauth/authorize");
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(res.headers.get("location")).not.toContain("shhh");
  });

  it("requires authentication", async () => {
    const { port } = start();
    const res = await fetch(`http://127.0.0.1:${port}/v1/exports/notion/start`, {
      redirect: "manual",
    });
    expect(res.status).toBe(401);
  });

  it("answers 503 when Notion OAuth is not configured", async () => {
    const { port, alice } = start({ notionOAuth: undefined });
    const res = await fetch(`http://127.0.0.1:${port}/v1/exports/notion/start`, {
      headers: { authorization: `Bearer ${alice.token}` },
      redirect: "manual",
    });
    expect(res.status).toBe(503);
  });

  // Fix round 1, Important 1: notionOAuth alone used to be enough to redirect
  // a user to Notion's real consent screen, even with nowhere to store what
  // they granted — a dead end reached only after they'd already handed over
  // access to a real workspace. `oauthStates` (unlike `notionOAuth`) is what
  // this route actually gates on, and index.ts now only wires it when
  // `destinations` also exists (see serverOptions.test.ts for that gating
  // logic in isolation) — this exercises the same guarantee at the route.
  it("answers 503, never redirecting to Notion, when there is nowhere to store the connection", async () => {
    const { port, alice } = start({ oauthStates: undefined });
    const res = await fetch(`http://127.0.0.1:${port}/v1/exports/notion/start`, {
      headers: { authorization: `Bearer ${alice.token}` },
      redirect: "manual",
    });
    expect(res.status).toBe(503);
  });
});

describe("GET /v1/exports/notion/callback", () => {
  it("stores the token against the user who began the flow", async () => {
    const { port, destinations, oauthStates, alice } = start();
    const state = oauthStates.mint(alice.userId);

    const res = await fetch(
      `http://127.0.0.1:${port}/v1/exports/notion/callback?code=good-code&state=${state}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/app/exports?notion=connected");
    expect(destinations.getNotion(alice.userId)).toEqual({
      token: "ntn_granted",
      config: { databaseId: "db1", workspaceName: "Alice's Notes" },
    });
  });

  it("refuses an unknown state and stores nothing", async () => {
    const { port, destinations, alice } = start();
    const res = await fetch(
      `http://127.0.0.1:${port}/v1/exports/notion/callback?code=good-code&state=forged`,
      { redirect: "manual" },
    );
    expect(res.headers.get("location")).toBe("/app/exports?notion=failed");
    expect(destinations.getNotion(alice.userId)).toBeNull();
  });

  it("refuses a replayed state", async () => {
    const { port, oauthStates, alice } = start();
    const state = oauthStates.mint(alice.userId);
    await fetch(`http://127.0.0.1:${port}/v1/exports/notion/callback?code=good-code&state=${state}`, {
      redirect: "manual",
    });
    const replay = await fetch(
      `http://127.0.0.1:${port}/v1/exports/notion/callback?code=good-code&state=${state}`,
      { redirect: "manual" },
    );
    expect(replay.headers.get("location")).toBe("/app/exports?notion=failed");
  });

  it("reports failure when Notion rejects the code, and stores nothing", async () => {
    const { port, destinations, oauthStates, alice } = start();
    const state = oauthStates.mint(alice.userId);
    const res = await fetch(
      `http://127.0.0.1:${port}/v1/exports/notion/callback?code=bad-code&state=${state}`,
      { redirect: "manual" },
    );
    expect(res.headers.get("location")).toBe("/app/exports?notion=failed");
    expect(destinations.getNotion(alice.userId)).toBeNull();
  });

  // --- Coverage for the database-resolution correction (see task-5 brief) ---
  //
  // Notion's token exchange carries a database id only for template-based
  // integrations. A normal integration returns none, so the callback must
  // search for one itself using the freshly granted token.

  it("resolves the database via search when the exchange supplies none", async () => {
    // Captured outside the fake rather than asserted inside it: an
    // `expect` failing inside `findNotionDatabase` would throw into the
    // route's own try/catch and come out as a misleading "redirected to
    // failed" assertion mismatch instead of "wrong token was passed".
    let receivedToken: string | undefined;
    const { port, destinations, oauthStates, alice } = start({
      exchangeNotionCode: async (code) => {
        if (code !== "good-code") throw new Error("bad code");
        // No databaseId and no workspaceName — exactly what a normal
        // (non-template) Notion integration returns.
        return { accessToken: "ntn_granted" };
      },
      findNotionDatabase: async (accessToken) => {
        receivedToken = accessToken;
        return { id: "db-found", title: "Found DB" };
      },
    });
    const state = oauthStates.mint(alice.userId);

    const res = await fetch(
      `http://127.0.0.1:${port}/v1/exports/notion/callback?code=good-code&state=${state}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/app/exports?notion=connected");
    expect(receivedToken).toBe("ntn_granted");
    expect(destinations.getNotion(alice.userId)).toEqual({
      token: "ntn_granted",
      config: { databaseId: "db-found", workspaceName: "Found DB" },
    });
  });

  it("stores nothing and redirects with nodatabase when the search finds none", async () => {
    const { port, destinations, oauthStates, alice } = start({
      exchangeNotionCode: async () => ({ accessToken: "ntn_granted" }),
      findNotionDatabase: async () => null,
    });
    const state = oauthStates.mint(alice.userId);

    const res = await fetch(
      `http://127.0.0.1:${port}/v1/exports/notion/callback?code=good-code&state=${state}`,
      { redirect: "manual" },
    );
    expect(res.headers.get("location")).toBe("/app/exports?notion=nodatabase");
    expect(destinations.getNotion(alice.userId)).toBeNull();
  });

  it("fails rather than reporting nodatabase when findNotionDatabase itself is not wired up", async () => {
    // An exchange that supplies no databaseId but no findNotionDatabase seam
    // configured is a deployment gap (Task 8 wiring), not "the user shares
    // no database" — the two must not produce the same message, since only
    // one of them is something the user can fix.
    const { port, destinations, oauthStates, alice } = start({
      exchangeNotionCode: async () => ({ accessToken: "ntn_granted" }),
      findNotionDatabase: undefined,
    });
    const state = oauthStates.mint(alice.userId);

    const res = await fetch(
      `http://127.0.0.1:${port}/v1/exports/notion/callback?code=good-code&state=${state}`,
      { redirect: "manual" },
    );
    expect(res.headers.get("location")).toBe("/app/exports?notion=failed");
    expect(destinations.getNotion(alice.userId)).toBeNull();
  });

  it("reports a distinct denied reason when the user cancels on Notion's consent screen", async () => {
    const { port, destinations, oauthStates, alice } = start();
    const state = oauthStates.mint(alice.userId);

    const res = await fetch(
      `http://127.0.0.1:${port}/v1/exports/notion/callback?error=access_denied&state=${state}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/app/exports?notion=denied");
    expect(destinations.getNotion(alice.userId)).toBeNull();
  });

  it("redirects to failure, rather than crashing, when the exchange throws a non-Error value", async () => {
    const { port, destinations, oauthStates, alice } = start({
      exchangeNotionCode: async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw "boom";
      },
    });
    const state = oauthStates.mint(alice.userId);

    const res = await fetch(
      `http://127.0.0.1:${port}/v1/exports/notion/callback?code=good-code&state=${state}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/app/exports?notion=failed");
    expect(destinations.getNotion(alice.userId)).toBeNull();
  });
});

describe("DELETE /v1/exports/notion", () => {
  it("removes only the caller's connection", async () => {
    const { port, destinations, alice, mallory } = start();
    destinations.putNotion(alice.userId, "a", { databaseId: "db1" });
    destinations.putNotion(mallory.userId, "m", { databaseId: "db2" });

    const res = await fetch(`http://127.0.0.1:${port}/v1/exports/notion`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(await res.json()).toEqual({ removed: true });
    expect(destinations.getNotion(alice.userId)).toBeNull();
    expect(destinations.getNotion(mallory.userId)).not.toBeNull();
  });

  it("requires authentication", async () => {
    const { port } = start();
    const res = await fetch(`http://127.0.0.1:${port}/v1/exports/notion`, {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });

  // Final review, smaller item 3: this used to answer `200 {removed:false}`
  // with no store configured, where every sibling route 503s. That reads to
  // `/app/exports` as a Disconnect that worked.
  it("answers 503, not a successful no-op, when there is nowhere to disconnect from", async () => {
    const { port, alice } = start({ destinations: undefined });
    const res = await fetch(`http://127.0.0.1:${port}/v1/exports/notion`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(res.status).toBe(503);
  });
});

describe("POST /v1/exports/email", () => {
  it("requires authentication", async () => {
    const { port } = start();
    const res = await fetch(`http://127.0.0.1:${port}/v1/exports/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: "a@example.com" }),
    });
    expect(res.status).toBe(401);
  });

  it("answers 503 when email export is not configured", async () => {
    const { port, alice } = start({ sendEmail: undefined });
    const res = await fetch(`http://127.0.0.1:${port}/v1/exports/email`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${alice.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ address: "a@example.com" }),
    });
    expect(res.status).toBe(503);
  });

  it("rejects a malformed address with 400 and stores nothing", async () => {
    const { port, destinations, alice } = start();
    const res = await fetch(`http://127.0.0.1:${port}/v1/exports/email`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${alice.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ address: "not-an-email" }),
    });
    expect(res.status).toBe(400);
    expect(destinations.getEmail(alice.userId)).toBeNull();
  });

  // Fix-round Minor 2: a failed provider call must not destroy a
  // previously-working, already-verified destination — the user should be
  // left with the working address they had, not nothing.
  it("does not overwrite an existing verified destination when the send fails", async () => {
    const { port, destinations, alice } = start({
      sendEmail: async () => {
        throw new Error("resend down");
      },
    });
    destinations.putEmail(alice.userId, {
      address: "old@example.com",
      verifiedAt: "2026-01-01T00:00:00.000Z",
    });

    const res = await fetch(`http://127.0.0.1:${port}/v1/exports/email`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${alice.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ address: "new@example.com" }),
    });
    expect(res.status).toBe(502);
    expect(destinations.getEmail(alice.userId)).toEqual({
      address: "old@example.com",
      verifiedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("stores the address unverified and mails a confirmation link, without marking it verified", async () => {
    const { port, destinations, sentEmails, alice } = start();
    const res = await fetch(`http://127.0.0.1:${port}/v1/exports/email`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${alice.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ address: "a@example.com" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pending: true });

    // Stored, but not yet usable to receive a transcript — that only happens
    // once the confirmation link below is followed.
    const stored = destinations.getEmail(alice.userId);
    expect(stored?.address).toBe("a@example.com");
    expect(stored?.verifiedAt).toBeUndefined();

    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].to).toBe("a@example.com");
    const link = sentEmails[0].text.match(/https:\S+/)?.[0];
    expect(link).toContain("/v1/exports/email/confirm?token=");
  });

  it("rate limits repeated verification sends", async () => {
    const { port, alice } = start();
    const attempt = () =>
      fetch(`http://127.0.0.1:${port}/v1/exports/email`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${alice.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ address: "a@example.com" }),
      });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push((await attempt()).status);
    }
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
  });
});

describe("GET /v1/exports/email/confirm", () => {
  async function requestConfirmation(port: number, token: string) {
    return fetch(`http://127.0.0.1:${port}/v1/exports/email`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ address: "a@example.com" }),
    });
  }

  it("verifies the address when the mailed link is followed", async () => {
    const { port, destinations, sentEmails, alice } = start();
    await requestConfirmation(port, alice.token);
    const link = sentEmails[0].text.match(/https:\S+/)![0];
    const token = new URL(link).searchParams.get("token")!;

    const res = await fetch(`http://127.0.0.1:${port}/v1/exports/email/confirm?token=${token}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/app/exports?email=confirmed");
    expect(destinations.getEmail(alice.userId)?.verifiedAt).toBeTruthy();
  });

  it("a forged token verifies nothing", async () => {
    const { port, destinations, alice } = start();
    const res = await fetch(
      `http://127.0.0.1:${port}/v1/exports/email/confirm?token=forged-token`,
      { redirect: "manual" },
    );
    expect(res.headers.get("location")).toBe("/app/exports?email=failed");
    expect(destinations.getEmail(alice.userId)).toBeNull();
  });

  // Spec section 6: the confirmation endpoint must be rate limited. It is
  // unauthenticated, so the key is the client address, not a device.
  it("stops answering after too many attempts from one address", async () => {
    const { port } = start();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/exports/email/confirm?token=guess-${i}`,
        { redirect: "manual" },
      );
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(302));
    expect(statuses[10]).toBe(429);
  });

  it("a token cannot be used a second time", async () => {
    const { port, destinations, sentEmails, alice } = start();
    await requestConfirmation(port, alice.token);
    const link = sentEmails[0].text.match(/https:\S+/)![0];
    const token = new URL(link).searchParams.get("token")!;

    await fetch(`http://127.0.0.1:${port}/v1/exports/email/confirm?token=${token}`, {
      redirect: "manual",
    });
    // Un-verify to make a replay's effect observable.
    destinations.putEmail(alice.userId, { address: "a@example.com" });

    const replay = await fetch(
      `http://127.0.0.1:${port}/v1/exports/email/confirm?token=${token}`,
      { redirect: "manual" },
    );
    expect(replay.headers.get("location")).toBe("/app/exports?email=failed");
    expect(destinations.getEmail(alice.userId)?.verifiedAt).toBeUndefined();
  });
});

describe("DELETE /v1/exports/email", () => {
  it("removes only the caller's own destination", async () => {
    const { port, destinations, alice, mallory } = start();
    destinations.putEmail(alice.userId, { address: "a@example.com" });
    destinations.putEmail(mallory.userId, { address: "m@example.com" });

    const res = await fetch(`http://127.0.0.1:${port}/v1/exports/email`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(await res.json()).toEqual({ removed: true });
    expect(destinations.getEmail(alice.userId)).toBeNull();
    expect(destinations.getEmail(mallory.userId)).not.toBeNull();
  });

  it("requires authentication", async () => {
    const { port } = start();
    const res = await fetch(`http://127.0.0.1:${port}/v1/exports/email`, {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });

  it("answers 503, not a successful no-op, when there is nowhere to disconnect from", async () => {
    const { port, alice } = start({ destinations: undefined });
    const res = await fetch(`http://127.0.0.1:${port}/v1/exports/email`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(res.status).toBe(503);
  });

  // Fix-round Minor 1: deleting a destination must also invalidate any
  // outstanding confirmation link for it — otherwise a still-valid link,
  // followed after the delete, recreates the destination already verified.
  it("invalidates a pending confirmation link, so it cannot resurrect a deleted destination", async () => {
    const { port, destinations, sentEmails, alice } = start();
    await fetch(`http://127.0.0.1:${port}/v1/exports/email`, {
      method: "POST",
      headers: { authorization: `Bearer ${alice.token}`, "content-type": "application/json" },
      body: JSON.stringify({ address: "a@example.com" }),
    });
    const link = sentEmails[0].text.match(/https:\S+/)![0];
    const token = new URL(link).searchParams.get("token")!;

    const del = await fetch(`http://127.0.0.1:${port}/v1/exports/email`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(await del.json()).toEqual({ removed: true });

    const confirm = await fetch(
      `http://127.0.0.1:${port}/v1/exports/email/confirm?token=${token}`,
      { redirect: "manual" },
    );
    expect(confirm.headers.get("location")).toBe("/app/exports?email=failed");
    expect(destinations.getEmail(alice.userId)).toBeNull();
  });
});

describe("legacy Notion config migration", () => {
  it("folds NOTION_TOKEN into the operator's destination row", () => {
    const db = openDb(":memory:");
    const identity = new IdentityStore(db);
    const operator = identity.registerDevice("mac").userId;
    const destinations = new ExportDestinationStore(db, randomBytes(32));

    adoptLegacyNotion(destinations, operator, { token: "ntn_legacy", databaseId: "db-legacy" });

    expect(destinations.getNotion(operator)).toEqual({
      token: "ntn_legacy",
      config: { databaseId: "db-legacy" },
    });
  });

  it("does not overwrite a connection the user already made", () => {
    const db = openDb(":memory:");
    const identity = new IdentityStore(db);
    const operator = identity.registerDevice("mac").userId;
    const destinations = new ExportDestinationStore(db, randomBytes(32));
    destinations.putNotion(operator, "ntn_current", { databaseId: "db-current" });

    adoptLegacyNotion(destinations, operator, { token: "ntn_legacy", databaseId: "db-legacy" });

    expect(destinations.getNotion(operator)!.token).toBe("ntn_current");
  });
});

// Fix round 1, Critical 1: `adoptLegacyNotion` alone has no way to find its
// "operator" — the boot wiring used to hand it the transcript migration's
// adopted user id, but that migration runs (if at all) on a different
// branch/plan and its result is null on every later boot, which meant this
// silently never fired for the exact operators it exists to help: someone
// upgrading a working single-workspace NOTION_TOKEN straight to per-user
// destinations, with no prior multi-tenancy migration to hang the adoption
// on. This wrapper decouples "who is the operator" from that migration
// entirely, using only the identity store's own user count.
describe("adoptLegacyNotionIfUnambiguous", () => {
  function fixture() {
    const db = openDb(":memory:");
    const identity = new IdentityStore(db);
    const destinations = new ExportDestinationStore(db, randomBytes(32));
    return { identity, destinations };
  }

  const legacy = { token: "ntn_legacy", databaseId: "db-legacy" };

  it("adopts onto the one existing user", () => {
    const { identity, destinations } = fixture();
    const solo = identity.registerDevice("mac").userId;

    const result = adoptLegacyNotionIfUnambiguous(identity, destinations, legacy);

    expect(result).toEqual({ outcome: "adopted", userId: solo });
    expect(destinations.getNotion(solo)).toEqual({
      token: "ntn_legacy",
      config: { databaseId: "db-legacy" },
    });
  });

  it("reports ambiguous and adopts nothing when there is more than one user", () => {
    const { identity, destinations } = fixture();
    const alice = identity.registerDevice("phone").userId;
    const mallory = identity.registerDevice("phone").userId;

    const result = adoptLegacyNotionIfUnambiguous(identity, destinations, legacy);

    expect(result).toEqual({ outcome: "ambiguous" });
    expect(destinations.getNotion(alice)).toBeNull();
    expect(destinations.getNotion(mallory)).toBeNull();
  });

  it("reports ambiguous when there are no users yet", () => {
    const { identity, destinations } = fixture();
    expect(adoptLegacyNotionIfUnambiguous(identity, destinations, legacy)).toEqual({
      outcome: "ambiguous",
    });
  });

  it("reports not-configured when there is nowhere to store the connection", () => {
    const { identity } = fixture();
    identity.registerDevice("mac");
    expect(adoptLegacyNotionIfUnambiguous(identity, undefined, legacy)).toEqual({
      outcome: "not-configured",
    });
  });

  it("reports not-configured when there is no legacy config", () => {
    const { identity, destinations } = fixture();
    identity.registerDevice("mac");
    expect(adoptLegacyNotionIfUnambiguous(identity, destinations, undefined)).toEqual({
      outcome: "not-configured",
    });
  });

  // Fix round 2, Important: adoption used to be able to fire on every boot
  // with no memory of having run before, so a user's deliberate Disconnect
  // (DELETE /v1/exports/notion, wired to the Disconnect button in
  // exportsPage.ts — it just removes the row) would be silently undone by
  // the next boot's adoption sweep. Verified red against the round-1 code
  // (no marker check at all): this failed with `{outcome: "adopted", ...}`
  // and a re-populated connection.
  it("does not re-adopt after the user disconnects", () => {
    const { identity, destinations } = fixture();
    const solo = identity.registerDevice("mac").userId;

    const first = adoptLegacyNotionIfUnambiguous(identity, destinations, legacy);
    expect(first).toEqual({ outcome: "adopted", userId: solo });

    destinations.remove(solo, "notion");

    const second = adoptLegacyNotionIfUnambiguous(identity, destinations, legacy);
    expect(second).not.toEqual({ outcome: "adopted", userId: solo });
    expect(destinations.getNotion(solo)).toBeNull();
  });

  // A no-op boot (nothing to adopt, nothing changed) must be distinguishable
  // from a real adoption in the returned outcome — this is also what an
  // operator-facing log needs to tell them it's safe to unset NOTION_TOKEN.
  it("reports already-resolved, not adopted, on a repeat boot with no changes", () => {
    const { identity, destinations } = fixture();
    const solo = identity.registerDevice("mac").userId;
    adoptLegacyNotionIfUnambiguous(identity, destinations, legacy);

    const second = adoptLegacyNotionIfUnambiguous(identity, destinations, legacy);

    expect(second).toEqual({ outcome: "already-resolved", userId: solo });
  });

  it("reports already-resolved, not adopted, when the sole user already had their own connection", () => {
    const { identity, destinations } = fixture();
    const solo = identity.registerDevice("mac").userId;
    destinations.putNotion(solo, "ntn_own", { databaseId: "db-own" });

    const result = adoptLegacyNotionIfUnambiguous(identity, destinations, legacy);

    expect(result).toEqual({ outcome: "already-resolved", userId: solo });
    expect(destinations.getNotion(solo)!.token).toBe("ntn_own");
  });
});

// Final review, Important 1: the entrypoint calls this at module scope, so a
// throw here is not "adoption failed" — it is the relay failing to boot at
// all, on a loop, with captioning down for an export-only reason. There is no
// test that can boot `index.ts` (real API keys, a writable volume, a listening
// port), so the guarantee is asserted one layer down, on the function the
// entrypoint is required — by `deployWiring.test.ts` — to call instead of the
// throwing one.
describe("adoptLegacyNotionAtBoot", () => {
  const legacy = { token: "ntn_legacy", databaseId: "db-legacy" };

  /**
   * A sole user whose stored Notion secret cannot be opened under the store's
   * current key: `ENCRYPTION_KEY` rotated, or the database restored into
   * another environment. `open()` throws on the auth-tag check.
   */
  function unopenableFixture() {
    const db = openDb(":memory:");
    const identity = new IdentityStore(db);
    const solo = identity.registerDevice("mac").userId;
    new ExportDestinationStore(db, randomBytes(32)).putNotion(solo, "ntn_own", {
      databaseId: "db-own",
    });
    return { identity, destinations: new ExportDestinationStore(db, randomBytes(32)) };
  }

  /**
   * A store whose write fails. Adoption no longer decrypts, but it still
   * writes — `putNotion` and the resolution marker are both SQLite writes
   * that can fail on a full or read-only volume, which is the hazard the
   * boot guard actually exists for.
   */
  function throwingFixture() {
    const db = openDb(":memory:");
    const identity = new IdentityStore(db);
    identity.registerDevice("mac");
    const destinations = new ExportDestinationStore(db, randomBytes(32));
    destinations.putNotion = () => {
      throw new Error("disk full");
    };
    return { identity, destinations };
  }

  // Adoption used to reach `getNotion` -> `secretBox.open()`, so a row it
  // could not decrypt crashed the boot. It now asks `hasNotion`, which never
  // decrypts, so that particular scenario is simply fine — recorded here so
  // the improvement does not get undone silently.
  it("no longer needs to decrypt, so an unopenable row is not a boot hazard", () => {
    const { identity, destinations } = unopenableFixture();
    expect(() => adoptLegacyNotionIfUnambiguous(identity, destinations, legacy)).not.toThrow();
    // And it must leave that row alone rather than treating it as an empty
    // slot: the user's own connection, not the operator's, stays in place.
    expect(destinations.hasNotion(identity.soleUserId()!)).toBe(true);
  });

  it("survives an adoption that throws, instead of taking the process down with it", () => {
    const { identity, destinations } = throwingFixture();
    // Pins the premise: without this, the test would still pass if the
    // scenario quietly stopped being a throwing one.
    expect(() => adoptLegacyNotionIfUnambiguous(identity, destinations, legacy)).toThrow();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    let result: unknown;
    expect(() => {
      result = adoptLegacyNotionAtBoot(identity, destinations, legacy);
    }).not.toThrow();

    expect(result).toEqual({ outcome: "failed" });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("is otherwise the same adoption, so guarding it costs nothing", () => {
    const db = openDb(":memory:");
    const identity = new IdentityStore(db);
    const solo = identity.registerDevice("mac").userId;
    const destinations = new ExportDestinationStore(db, randomBytes(32));

    expect(adoptLegacyNotionAtBoot(identity, destinations, legacy)).toEqual({
      outcome: "adopted",
      userId: solo,
    });
    expect(destinations.getNotion(solo)).toEqual({
      token: "ntn_legacy",
      config: { databaseId: "db-legacy" },
    });
  });
});
