import { describe, it, expect } from "vitest";
import { verifyToken } from "./auth";

describe("verifyToken", () => {
  it("accepts a matching token", () => {
    expect(verifyToken("secret123", "secret123")).toBe(true);
  });

  it("rejects a wrong token", () => {
    expect(verifyToken("wrong", "secret123")).toBe(false);
  });

  it("rejects a missing token", () => {
    expect(verifyToken(undefined, "secret123")).toBe(false);
  });

  it("rejects when no expected token is configured", () => {
    expect(verifyToken("anything", "")).toBe(false);
  });
});
