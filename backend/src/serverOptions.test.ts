import { describe, it, expect } from "vitest";
import { randomBytes } from "crypto";
import { openDb } from "./db";
import { IdentityStore } from "./identityStore";
import { Config } from "./config";
import { buildServerOptions, buildResolveExporters } from "./serverOptions";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";
import { ExportDestinationStore } from "./exportDestinations";
import { FinalizedTranscript } from "./transcriptStore";
import { NotionExporterOptions } from "./notionExporter";

const transcript: FinalizedTranscript = {
  name: "2026-01-01T00-00-00Z_s1",
  userId: "alice",
  sessionId: "s1",
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: "2026-01-01T00:01:00.000Z",
  segments: [{ at: "2026-01-01T00:00:30.000Z", text: "hello" }],
};

/** A Notion fetch that always fails with the given status. */
const failWith = (status: number, message: string) =>
  (async () => ({
    ok: false,
    status,
    json: async () => ({ message }),
  })) as unknown as NotionExporterOptions["fetch"];

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

// Fix round 2, smaller item 1: every test above only asserts the eight
// optional, config-gated fields — an extraction that silently dropped or
// mis-bound one of the *unconditional* fields (adminToken, callForwardTo,
// ...) would satisfy every one of them. This pins the rest of
// `StartServerOptions` — everything not already covered by the gating tests
// above — in one place.
describe("buildServerOptions base fields", () => {
  it("passes every non-gated option straight through from config and deps", () => {
    const usage = { getUsage: async () => ({}) as never };
    const config = baseConfig({ port: 4242, adminToken: "admin-secret", twilioForwardTo: "+15551234567" });
    const deps = fixtureDeps();

    const options = buildServerOptions(config, { ...deps, usage });

    expect(options).toMatchObject({
      port: 4242,
      identity: deps.identity,
      adminToken: "admin-secret",
      createProvider: deps.createProvider,
      transcriptsRoot: "/does-not-matter",
      usage,
      callForwardTo: "+15551234567",
      trustProxyHeaders: false,
    });
    expect(options.transcripts).toBeDefined();
  });
});

describe("buildResolveExporters", () => {
  it("resolves nothing for any user when there are no destinations", () => {
    expect(buildResolveExporters(undefined)("user-1")).toBeUndefined();
  });
});

describe("buildResolveExporters revocation", () => {
  function connected() {
    const db = openDb(":memory:");
    const identity = new IdentityStore(db);
    const alice = identity.registerDevice("phone").userId;
    const destinations = new ExportDestinationStore(db, randomBytes(32));
    destinations.putNotion(alice, "ntn_secret", { databaseId: "db1" });
    return { destinations, alice };
  }

  it("marks the destination revoked when Notion answers 401", async () => {
    const { destinations, alice } = connected();
    const resolve = buildResolveExporters(destinations, {
      fetchImpl: failWith(401, "API token is invalid."),
    });

    await expect(resolve(alice)!.export(transcript, null)).rejects.toThrow();
    expect(destinations.getNotion(alice)).toBeNull();
    expect(destinations.list(alice)[0]!.connected).toBe(false);
  });

  it("does not revoke on a non-auth failure", async () => {
    const { destinations, alice } = connected();
    const resolve = buildResolveExporters(destinations, {
      fetchImpl: failWith(500, "boom"),
    });

    await expect(resolve(alice)!.export(transcript, null)).rejects.toThrow();
    expect(destinations.getNotion(alice)).not.toBeNull();
    expect(destinations.list(alice)[0]!.connected).toBe(true);
  });

  it("re-throws the 401 rather than swallowing it", async () => {
    const { destinations, alice } = connected();
    const resolve = buildResolveExporters(destinations, {
      fetchImpl: failWith(401, "API token is invalid."),
    });
    await expect(resolve(alice)!.export(transcript, null)).rejects.toThrow(/401/);
  });

  it("returns undefined once revoked, so nothing retries the dead token", () => {
    const { destinations, alice } = connected();
    destinations.markNotionRevoked(alice);
    expect(buildResolveExporters(destinations)(alice)).toBeUndefined();
  });
});
