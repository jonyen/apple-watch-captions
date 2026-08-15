import { describe, it, expect } from "vitest";
import { openDb } from "./db";
import { IdentityStore } from "./identityStore";
import {
  OAuthStateStore,
  authorizeUrl,
  createCodeExchange,
  createDatabaseFinder,
  OAUTH_STATE_TTL_MS,
} from "./notionOAuth";
import { NOTION_VERSION } from "./notionExporter";

const config = {
  clientId: "client-1",
  clientSecret: "shhh",
  redirectUri: "https://relay.example/v1/exports/notion/callback",
};

function fixture(now?: () => number) {
  const db = openDb(":memory:");
  const identity = new IdentityStore(db);
  const alice = identity.registerDevice("phone").userId;
  return { store: new OAuthStateStore(db, now ? { now } : {}), alice };
}

describe("OAuthStateStore", () => {
  it("round-trips a state to its user", () => {
    const { store, alice } = fixture();
    expect(store.consume(store.mint(alice))).toBe(alice);
  });

  it("is single use", () => {
    const { store, alice } = fixture();
    const state = store.mint(alice);
    expect(store.consume(state)).toBe(alice);
    expect(store.consume(state)).toBeNull();
  });

  it("rejects an unknown state", () => {
    const { store } = fixture();
    expect(store.consume("never-minted")).toBeNull();
  });

  it("rejects an expired state", () => {
    let clock = 1_000_000;
    const { store, alice } = fixture(() => clock);
    const state = store.mint(alice);
    clock += OAUTH_STATE_TTL_MS + 1;
    expect(store.consume(state)).toBeNull();
  });

  it("mints unguessable values", () => {
    const { store, alice } = fixture();
    const state = store.mint(alice);
    expect(state.length).toBeGreaterThan(20);
    expect(state).not.toContain(alice);
  });
});

describe("authorizeUrl", () => {
  it("carries the client id, redirect uri and state", () => {
    const url = new URL(authorizeUrl(config, "state-1"));
    expect(url.origin + url.pathname).toBe("https://api.notion.com/v1/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("response_type")).toBe("code");
  });

  it("never carries the client secret", () => {
    expect(authorizeUrl(config, "state-1")).not.toContain("shhh");
  });
});

describe("createCodeExchange", () => {
  it("posts the code with basic auth and returns the token", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen = { url: String(url), init };
      return {
        ok: true,
        json: async () => ({
          access_token: "ntn_granted",
          workspace_name: "Alice's Notes",
          duplicated_template_id: "db-xyz",
        }),
      };
    }) as unknown as typeof fetch;

    const result = await createCodeExchange(config, fakeFetch)("code-1");

    expect(result.accessToken).toBe("ntn_granted");
    expect(result.workspaceName).toBe("Alice's Notes");
    expect(seen!.url).toBe("https://api.notion.com/v1/oauth/token");
    const expected = Buffer.from("client-1:shhh").toString("base64");
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe(`Basic ${expected}`);
    expect(JSON.parse(String(seen!.init.body))).toEqual({
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: config.redirectUri,
    });
  });

  it("throws when Notion rejects the code", async () => {
    const fakeFetch = (async () => ({
      ok: false,
      status: 400,
      text: async () => "invalid_grant",
    })) as unknown as typeof fetch;
    await expect(createCodeExchange(config, fakeFetch)("bad")).rejects.toThrow(/400/);
  });
});

describe("createDatabaseFinder", () => {
  it("searches Notion for a database with the granted token", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen = { url: String(url), init };
      return { ok: true, json: async () => ({ results: [] }) };
    }) as unknown as typeof fetch;

    await createDatabaseFinder(fakeFetch)("ntn_granted");

    expect(seen!.url).toBe("https://api.notion.com/v1/search");
    const headers = seen!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ntn_granted");
    expect(headers["Notion-Version"]).toBe(NOTION_VERSION);
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(String(seen!.init.body))).toEqual({
      filter: { value: "database", property: "object" },
    });
  });

  it("returns the id and title of the first result", async () => {
    const fakeFetch = (async () => ({
      ok: true,
      json: async () => ({
        results: [
          {
            id: "db-first",
            title: [{ plain_text: "My " }, { plain_text: "Notes" }],
          },
          { id: "db-second", title: [{ plain_text: "Other" }] },
        ],
      }),
    })) as unknown as typeof fetch;

    const found = await createDatabaseFinder(fakeFetch)("ntn_granted");

    expect(found).toEqual({ id: "db-first", title: "My Notes" });
  });

  it("returns null when the search finds no database", async () => {
    const fakeFetch = (async () => ({
      ok: true,
      json: async () => ({ results: [] }),
    })) as unknown as typeof fetch;

    expect(await createDatabaseFinder(fakeFetch)("ntn_granted")).toBeNull();
  });

  it("throws when Notion rejects the search", async () => {
    const fakeFetch = (async () => ({
      ok: false,
      status: 401,
      text: async () => "invalid token",
    })) as unknown as typeof fetch;

    await expect(createDatabaseFinder(fakeFetch)("ntn_granted")).rejects.toThrow(/401/);
  });
});
