import { describe, it, expect } from "vitest";
import { randomBytes } from "crypto";
import { seal, open, keyFromEnv } from "./secretBox";

const key = randomBytes(32);

describe("secretBox", () => {
  it("round-trips a secret", () => {
    expect(open(seal("ntn_abc123", key), key)).toBe("ntn_abc123");
  });

  it("produces a different ciphertext each time", () => {
    expect(seal("same", key)).not.toBe(seal("same", key));
  });

  it("never contains the plaintext", () => {
    expect(seal("ntn_abc123", key)).not.toContain("ntn_abc123");
  });

  it("refuses a wrong key", () => {
    expect(() => open(seal("secret", key), randomBytes(32))).toThrow();
  });

  it("refuses tampered ciphertext", () => {
    const sealed = seal("secret", key);
    const parts = sealed.split(".");
    const bytes = Buffer.from(parts[3]!, "base64url");
    bytes[0] ^= 0xff;
    parts[3] = bytes.toString("base64url");
    expect(() => open(parts.join("."), key)).toThrow();
  });

  it("refuses an unknown version prefix", () => {
    const sealed = seal("secret", key);
    expect(() => open(sealed.replace(/^v1\./, "v2."), key)).toThrow(/version/i);
  });

  it("refuses a malformed value", () => {
    expect(() => open("not-sealed", key)).toThrow();
  });

  it("accepts a 32-byte base64 key", () => {
    expect(keyFromEnv(randomBytes(32).toString("base64")).length).toBe(32);
  });

  it("rejects a missing key", () => {
    expect(() => keyFromEnv(undefined)).toThrow(/ENCRYPTION_KEY/);
  });

  it("rejects a short key", () => {
    expect(() => keyFromEnv(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
  });
});
