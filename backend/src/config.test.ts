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
