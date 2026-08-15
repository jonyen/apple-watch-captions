import { describe, it, expect, vi } from "vitest";
import { loadConfig } from "./config";

describe("loadConfig", () => {
  it("reads values from the environment", () => {
    const cfg = loadConfig({
      PORT: "8080",
      DEEPGRAM_API_KEY: "dg-key",
    });
    expect(cfg).toEqual({
      port: 8080,
      deepgramApiKey: "dg-key",
      transcriptsDir: "./data/transcripts",
      adminToken: undefined,
      dbPath: "data/transcripts/identity.db",
      anthropicApiKey: undefined,
      deepgramPhoneModel: "phonecall",
      trustProxyHeaders: false,
    });
  });

  // Off by default because the relay may be exposed directly, where a
  // forgeable `Fly-Client-IP` would let any caller evade the registration
  // rate limit entirely.
  it("leaves proxy headers untrusted unless asked", () => {
    expect(loadConfig({ DEEPGRAM_API_KEY: "dg-key" }).trustProxyHeaders).toBe(false);
  });

  it("trusts proxy headers when TRUST_PROXY_HEADERS is set", () => {
    const base = { DEEPGRAM_API_KEY: "dg-key" };
    expect(loadConfig({ ...base, TRUST_PROXY_HEADERS: "true" }).trustProxyHeaders).toBe(true);
    expect(loadConfig({ ...base, TRUST_PROXY_HEADERS: "1" }).trustProxyHeaders).toBe(true);
    expect(loadConfig({ ...base, TRUST_PROXY_HEADERS: "false" }).trustProxyHeaders).toBe(false);
    expect(loadConfig({ ...base, TRUST_PROXY_HEADERS: "0" }).trustProxyHeaders).toBe(false);
  });

  // A typo here would silently either open the limiter to forged headers or
  // collapse every caller into one bucket, depending on which way it fell.
  // Fail closed and say so.
  it("warns and stays off for a TRUST_PROXY_HEADERS value it does not recognize", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cfg = loadConfig({ DEEPGRAM_API_KEY: "dg-key", TRUST_PROXY_HEADERS: "yes please" });
    expect(cfg.trustProxyHeaders).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("defaults dbPath beside the transcripts dir and leaves adminToken unset", () => {
    const cfg = loadConfig({ DEEPGRAM_API_KEY: "dg-key", TRANSCRIPTS_DIR: "/data/transcripts" });
    expect(cfg.dbPath).toBe("/data/transcripts/identity.db");
    expect(cfg.adminToken).toBeUndefined();
  });

  it("reads DB_PATH and ADMIN_TOKEN when set", () => {
    const cfg = loadConfig({
      DEEPGRAM_API_KEY: "dg-key",
      DB_PATH: "/data/identity.db",
      ADMIN_TOKEN: "admin-secret",
    });
    expect(cfg.dbPath).toBe("/data/identity.db");
    expect(cfg.adminToken).toBe("admin-secret");
  });

  it("reads transcript dir and anthropic key when set", () => {
    const cfg = loadConfig({
      DEEPGRAM_API_KEY: "dg-key",
      TRANSCRIPTS_DIR: "/data/transcripts",
      ANTHROPIC_API_KEY: "sk-ant-xxx",
    });
    expect(cfg.transcriptsDir).toBe("/data/transcripts");
    expect(cfg.anthropicApiKey).toBe("sk-ant-xxx");
  });

  it("reads the Gemini key and summary provider", () => {
    const cfg = loadConfig({
      DEEPGRAM_API_KEY: "dg-key",
      GEMINI_API_KEY: "gk-xxx",
      SUMMARY_PROVIDER: "gemini",
    });
    expect(cfg.geminiApiKey).toBe("gk-xxx");
    expect(cfg.summaryProvider).toBe("gemini");
  });

  it("leaves the summary provider unset when not configured", () => {
    const cfg = loadConfig({ DEEPGRAM_API_KEY: "dg-key" });
    expect(cfg.summaryProvider).toBeUndefined();
    expect(cfg.geminiApiKey).toBeUndefined();
  });

  it("ignores an unrecognized summary provider rather than failing to boot", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cfg = loadConfig({
      DEEPGRAM_API_KEY: "dg-key",
      SUMMARY_PROVIDER: "llama",
    });
    expect(cfg.summaryProvider).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("reads the Notion integration when both token and database are set", () => {
    const cfg = loadConfig({
      DEEPGRAM_API_KEY: "dg-key",
      NOTION_TOKEN: "ntn_xxx",
      NOTION_DATABASE_ID: "db-123",
    });
    expect(cfg.notion).toEqual({ token: "ntn_xxx", databaseId: "db-123" });
  });

  it("leaves Notion off when it is not configured", () => {
    const cfg = loadConfig({ DEEPGRAM_API_KEY: "dg-key" });
    expect(cfg.notion).toBeUndefined();
  });

  it("ignores a half-configured Notion integration rather than failing to boot", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cfg = loadConfig({
      DEEPGRAM_API_KEY: "dg-key",
      NOTION_TOKEN: "ntn_xxx",
    });
    expect(cfg.notion).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("leaves the encryption key unset when ENCRYPTION_KEY is not configured", () => {
    const cfg = loadConfig({ DEEPGRAM_API_KEY: "dg-key" });
    expect(cfg.encryptionKey).toBeUndefined();
  });

  it("reads ENCRYPTION_KEY when set", () => {
    const cfg = loadConfig({ DEEPGRAM_API_KEY: "dg-key", ENCRYPTION_KEY: "base64-key-value" });
    expect(cfg.encryptionKey).toBe("base64-key-value");
  });

  it("defaults the port to 8080 when unset", () => {
    const cfg = loadConfig({ DEEPGRAM_API_KEY: "dg-key" });
    expect(cfg.port).toBe(8080);
  });

  it("throws when DEEPGRAM_API_KEY is missing", () => {
    expect(() => loadConfig({})).toThrow(/DEEPGRAM_API_KEY/);
  });
});

// Final review, Important 2: `fly.toml` ships PUBLIC_BASE_URL pointing at
// this project's own fly.dev hostname, and `fly.dev` names are globally
// unique — so an operator deploying from scratch renames the app and, unless
// they also change this, builds a Notion redirect URI and an emailed
// confirmation link that point at a host they do not control. Notion then
// sends a live authorization code there, and the relay mails a live
// verification token (with the user's address) pointing at the same place.
// Neither is usable there; both leak.
describe("PUBLIC_BASE_URL sanity check", () => {
  const base = { DEEPGRAM_API_KEY: "k" };
  const messages = (warn: ReturnType<typeof vi.spyOn>) =>
    warn.mock.calls.map((call) => call.join(" ")).join("\n");

  it("warns, naming both values, when the host is not this Fly app's own hostname", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    loadConfig({
      ...base,
      FLY_APP_NAME: "their-relay",
      PUBLIC_BASE_URL: "https://watch-captions-relay.fly.dev",
    });
    const text = messages(warn);
    warn.mockRestore();
    expect(text).toContain("PUBLIC_BASE_URL");
    expect(text).toContain("https://watch-captions-relay.fly.dev");
    expect(text).toContain("their-relay");
  });

  it("says nothing when PUBLIC_BASE_URL already matches the app", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    loadConfig({
      ...base,
      FLY_APP_NAME: "their-relay",
      PUBLIC_BASE_URL: "https://their-relay.fly.dev",
    });
    const text = messages(warn);
    warn.mockRestore();
    expect(text).toBe("");
  });

  // Off Fly there is nothing to compare against, and a local run on
  // http://localhost:8080 is not a misconfiguration.
  it("says nothing when FLY_APP_NAME is unset", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    loadConfig({ ...base, PUBLIC_BASE_URL: "http://localhost:8080" });
    const text = messages(warn);
    warn.mockRestore();
    expect(text).toBe("");
  });

  // A custom domain is a legitimate mismatch, so this must never be fatal —
  // captioning does not depend on any of it.
  it("still boots on a mismatch rather than throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cfg = loadConfig({
      ...base,
      FLY_APP_NAME: "their-relay",
      PUBLIC_BASE_URL: "https://captions.example.com",
    });
    warn.mockRestore();
    expect(cfg.publicBaseUrl).toBe("https://captions.example.com");
  });
});

describe("call captioning config", () => {
  const base = { DEEPGRAM_API_KEY: "k" };

  it("defaults the phone model to the safe telephony baseline", () => {
    expect(loadConfig(base).deepgramPhoneModel).toBe("phonecall");
  });

  it("allows the phone model to be overridden", () => {
    expect(loadConfig({ ...base, DEEPGRAM_PHONE_MODEL: "flux-general-en" }).deepgramPhoneModel)
      .toBe("flux-general-en");
  });

  it("reads the number calls are forwarded to", () => {
    expect(loadConfig(base).twilioForwardTo).toBeUndefined();
    expect(loadConfig({ ...base, TWILIO_FORWARD_TO: "+15551234567" }).twilioForwardTo)
      .toBe("+15551234567");
  });
});
