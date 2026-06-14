import { describe, it, expect } from "vitest";
import { loadConfig } from "./config";

describe("loadConfig", () => {
  it("reads values from the environment", () => {
    const cfg = loadConfig({
      PORT: "8080",
      AUTH_TOKEN: "secret",
      DEEPGRAM_API_KEY: "dg-key",
    });
    expect(cfg).toEqual({ port: 8080, authToken: "secret", deepgramApiKey: "dg-key" });
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
