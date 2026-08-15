import { describe, it, expect, afterEach } from "vitest";
import { randomBytes } from "crypto";
import { startServer, CaptionServer, StartServerOptions } from "./server";
import { openDb } from "./db";
import { IdentityStore } from "./identityStore";
import { ExportDestinationStore } from "./exportDestinations";
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
});
