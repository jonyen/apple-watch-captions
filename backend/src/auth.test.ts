import { describe, it, expect } from "vitest";
import { bearerToken, resolveToken } from "./auth";
import { IdentityStore } from "./identityStore";
import { openDb } from "./db";

describe("bearerToken", () => {
  it("extracts a bearer token", () => {
    expect(bearerToken("Bearer abc123")).toBe("abc123");
  });

  it("accepts a lowercase scheme", () => {
    expect(bearerToken("bearer abc123")).toBe("abc123");
  });

  it("tolerates extra whitespace", () => {
    expect(bearerToken("Bearer    abc123  ")).toBe("abc123");
  });

  it("ignores a non-bearer scheme", () => {
    expect(bearerToken("Basic abc123")).toBeUndefined();
  });

  it("ignores a missing header", () => {
    expect(bearerToken(undefined)).toBeUndefined();
  });

  it("ignores a bearer header with no token", () => {
    expect(bearerToken("Bearer ")).toBeUndefined();
  });
});

describe("resolveToken", () => {
  it("resolves a registered token", () => {
    const identity = new IdentityStore(openDb(":memory:"));
    const registered = identity.registerDevice("watch");
    expect(resolveToken(identity, registered.token)).toEqual({
      userId: registered.userId,
      deviceId: registered.deviceId,
    });
  });

  it("rejects an unregistered token", () => {
    const identity = new IdentityStore(openDb(":memory:"));
    expect(resolveToken(identity, "nope")).toBeNull();
  });

  it("rejects a missing token", () => {
    const identity = new IdentityStore(openDb(":memory:"));
    expect(resolveToken(identity, undefined)).toBeNull();
  });
});
