import { describe, it, expect, vi } from "vitest";
import { loadConfig } from "./config";

describe("loadConfig", () => {
  it("reads values from the environment", () => {
    const cfg = loadConfig({
      PORT: "8080",
      AUTH_TOKEN: "secret",
      DEEPGRAM_API_KEY: "dg-key",
    });
    expect(cfg).toEqual({
      port: 8080,
      authToken: "secret",
      deepgramApiKey: "dg-key",
      transcriptsDir: "./data/transcripts",
      anthropicApiKey: undefined,
      deepgramPhoneModel: "phonecall",
    });
  });

  it("reads transcript dir and anthropic key when set", () => {
    const cfg = loadConfig({
      AUTH_TOKEN: "secret",
      DEEPGRAM_API_KEY: "dg-key",
      TRANSCRIPTS_DIR: "/data/transcripts",
      ANTHROPIC_API_KEY: "sk-ant-xxx",
    });
    expect(cfg.transcriptsDir).toBe("/data/transcripts");
    expect(cfg.anthropicApiKey).toBe("sk-ant-xxx");
  });

  it("reads the Gemini key and summary provider", () => {
    const cfg = loadConfig({
      AUTH_TOKEN: "secret",
      DEEPGRAM_API_KEY: "dg-key",
      GEMINI_API_KEY: "gk-xxx",
      SUMMARY_PROVIDER: "gemini",
    });
    expect(cfg.geminiApiKey).toBe("gk-xxx");
    expect(cfg.summaryProvider).toBe("gemini");
  });

  it("leaves the summary provider unset when not configured", () => {
    const cfg = loadConfig({ AUTH_TOKEN: "secret", DEEPGRAM_API_KEY: "dg-key" });
    expect(cfg.summaryProvider).toBeUndefined();
    expect(cfg.geminiApiKey).toBeUndefined();
  });

  it("ignores an unrecognized summary provider rather than failing to boot", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cfg = loadConfig({
      AUTH_TOKEN: "secret",
      DEEPGRAM_API_KEY: "dg-key",
      SUMMARY_PROVIDER: "llama",
    });
    expect(cfg.summaryProvider).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("reads the Notion integration when both token and database are set", () => {
    const cfg = loadConfig({
      AUTH_TOKEN: "secret",
      DEEPGRAM_API_KEY: "dg-key",
      NOTION_TOKEN: "ntn_xxx",
      NOTION_DATABASE_ID: "db-123",
    });
    expect(cfg.notion).toEqual({ token: "ntn_xxx", databaseId: "db-123" });
  });

  it("leaves Notion off when it is not configured", () => {
    const cfg = loadConfig({ AUTH_TOKEN: "secret", DEEPGRAM_API_KEY: "dg-key" });
    expect(cfg.notion).toBeUndefined();
  });

  it("ignores a half-configured Notion integration rather than failing to boot", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cfg = loadConfig({
      AUTH_TOKEN: "secret",
      DEEPGRAM_API_KEY: "dg-key",
      NOTION_TOKEN: "ntn_xxx",
    });
    expect(cfg.notion).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("defaults the port to 8080 when unset", () => {
    const cfg = loadConfig({ AUTH_TOKEN: "secret", DEEPGRAM_API_KEY: "dg-key" });
    expect(cfg.port).toBe(8080);
  });

  it("throws when AUTH_TOKEN is missing", () => {
    expect(() => loadConfig({ DEEPGRAM_API_KEY: "dg-key" })).toThrow(/AUTH_TOKEN/);
  });

  it("throws when DEEPGRAM_API_KEY is missing", () => {
    expect(() => loadConfig({ AUTH_TOKEN: "secret" })).toThrow(/DEEPGRAM_API_KEY/);
  });
});

describe("call captioning config", () => {
  const base = { AUTH_TOKEN: "t", DEEPGRAM_API_KEY: "k" };

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

  // Declared on the server for the whole of this branch and passed by
  // nothing: the ring budget was unconfigurable in practice.
  it("reads the ring budget", () => {
    const cfg = loadConfig({
      AUTH_TOKEN: "secret",
      DEEPGRAM_API_KEY: "dg-key",
      CALL_WAIT_ATTEMPTS: "3",
    });
    expect(cfg.callWaitAttempts).toBe(3);
  });

  it("leaves the ring budget unset when not configured", () => {
    const cfg = loadConfig({ AUTH_TOKEN: "secret", DEEPGRAM_API_KEY: "dg-key" });
    expect(cfg.callWaitAttempts).toBeUndefined();
  });

  // A budget below one would send every call straight to the fallback, and a
  // typo would send it to NaN. Neither is worth booting with — fall back to
  // the server's own default and say so.
  it.each(["0", "-2", "2.5", "many"])(
    "ignores an unusable ring budget of %s rather than failing to boot",
    (value) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const cfg = loadConfig({
        AUTH_TOKEN: "secret",
        DEEPGRAM_API_KEY: "dg-key",
        CALL_WAIT_ATTEMPTS: value,
      });
      expect(cfg.callWaitAttempts).toBeUndefined();
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    },
  );
});
