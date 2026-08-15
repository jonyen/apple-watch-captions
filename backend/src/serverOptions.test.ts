import { describe, it, expect } from "vitest";
import { randomBytes } from "crypto";
import { openDb } from "./db";
import { IdentityStore } from "./identityStore";
import { Config } from "./config";
import { buildServerOptions, buildResolveExporters } from "./serverOptions";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";

/**
 * `deployWiring.test.ts` can only confirm that index.ts's source text
 * *mentions* an option — it cannot catch an inverted gate, a value pinned to
 * `undefined`, or a shorthand bound to the wrong variable, because none of it
 * executes. These tests call the real gating logic with a fake `Config` and
 * an in-memory database and assert on what `startServer` would actually
 * receive.
 */
function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    deepgramApiKey: "dg-key",
    transcriptsDir: "/does-not-matter",
    dbPath: "/does-not-matter/identity.db",
    deepgramPhoneModel: "phonecall",
    trustProxyHeaders: false,
    ...overrides,
  };
}

function fixtureDeps() {
  const db = openDb(":memory:");
  return {
    db,
    identity: new IdentityStore(db),
    createProvider: () => new FakeTranscriptionProvider(),
  };
}

const notionOAuth = {
  clientId: "client-1",
  clientSecret: "shhh",
  redirectUri: "https://relay.example/v1/exports/notion/callback",
};

describe("buildServerOptions", () => {
  it("enables every optional route when every setting is present", () => {
    const config = baseConfig({
      encryptionKey: randomBytes(32).toString("base64"),
      notionOAuth,
      publicBaseUrl: "https://relay.example",
      resendApiKey: "resend-key",
      emailFrom: "transcripts@relay.example",
    });
    const options = buildServerOptions(config, fixtureDeps());
    expect(options.destinations).toBeDefined();
    expect(options.oauthStates).toBeDefined();
    expect(options.exchangeNotionCode).toBeDefined();
    expect(options.findNotionDatabase).toBeDefined();
    expect(options.emailVerifications).toBeDefined();
    expect(options.sendEmail).toBeDefined();
    expect(options.notionOAuth).toBe(notionOAuth);
    expect(options.publicBaseUrl).toBe("https://relay.example");
  });

  it("enables nothing optional when nothing is configured", () => {
    const options = buildServerOptions(baseConfig(), fixtureDeps());
    expect(options.destinations).toBeUndefined();
    expect(options.oauthStates).toBeUndefined();
    expect(options.exchangeNotionCode).toBeUndefined();
    expect(options.findNotionDatabase).toBeUndefined();
    expect(options.emailVerifications).toBeUndefined();
    expect(options.sendEmail).toBeUndefined();
  });

  // Fix round 1, Important 1: Notion OAuth fully configured but
  // ENCRYPTION_KEY is not. Without gating on `destinations` too, a user
  // could click Connect, grant a real workspace on Notion's actual consent
  // screen, and bounce back to a generic failure with no way to fix it —
  // there was never anywhere to store what they granted.
  it("does not offer to connect Notion when there is nowhere to store the connection", () => {
    const config = baseConfig({ notionOAuth, publicBaseUrl: "https://relay.example" });
    const options = buildServerOptions(config, fixtureDeps());
    expect(options.destinations).toBeUndefined();
    expect(options.oauthStates).toBeUndefined();
    expect(options.exchangeNotionCode).toBeUndefined();
    expect(options.findNotionDatabase).toBeUndefined();
    // notionOAuth itself is still passed through — harmless on its own,
    // since the `/start` route's existing `!opts.oauthStates` check 503s
    // regardless — but pinned here so a future change can't quietly start
    // relying on this field alone to gate the route.
    expect(options.notionOAuth).toBe(notionOAuth);
  });
});

describe("buildResolveExporters", () => {
  it("resolves nothing for any user when there are no destinations", () => {
    expect(buildResolveExporters(undefined)("user-1")).toBeUndefined();
  });
});
