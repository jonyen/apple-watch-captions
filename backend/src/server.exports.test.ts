import { describe, it, expect, afterEach } from "vitest";
import { randomBytes } from "crypto";
import { startServer, CaptionServer, StartServerOptions } from "./server";
import { openDb } from "./db";
import { IdentityStore } from "./identityStore";
import { ExportDestinationStore } from "./exportDestinations";
import { OAuthStateStore } from "./notionOAuth";
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
  const alice = identity.registerDevice("phone");
  const mallory = identity.registerDevice("phone");
  server = startServer({
    port: 0,
    identity,
    destinations,
    oauthStates,
    notionOAuth,
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
    expect(await res.text()).not.toContain("ntn_secret");
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
    const { port, destinations, oauthStates, alice } = start({
      exchangeNotionCode: async (code) => {
        if (code !== "good-code") throw new Error("bad code");
        // No databaseId and no workspaceName — exactly what a normal
        // (non-template) Notion integration returns.
        return { accessToken: "ntn_granted" };
      },
      findNotionDatabase: async (accessToken) => {
        expect(accessToken).toBe("ntn_granted");
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
});
