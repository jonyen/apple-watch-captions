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
    });
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

  it("defaults the port to 8080 when unset", () => {
    const cfg = loadConfig({ DEEPGRAM_API_KEY: "dg-key" });
    expect(cfg.port).toBe(8080);
  });

  it("throws when DEEPGRAM_API_KEY is missing", () => {
    expect(() => loadConfig({})).toThrow(/DEEPGRAM_API_KEY/);
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
