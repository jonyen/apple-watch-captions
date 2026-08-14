import { randomUUID } from "crypto";
import { describe, it, expect } from "vitest";
import { openDb } from "./db";
import { IdentityStore } from "./identityStore";

function store(): IdentityStore {
  return new IdentityStore(openDb(":memory:"));
}

describe("IdentityStore registration", () => {
  it("issues a device, a user, and a token", () => {
    const registered = store().registerDevice("watch");
    expect(registered.deviceId).toBeTruthy();
    expect(registered.userId).toBeTruthy();
    expect(registered.token.length).toBeGreaterThan(20);
  });

  it("gives each registration its own user", () => {
    const s = store();
    expect(s.registerDevice("watch").userId).not.toBe(s.registerDevice("phone").userId);
  });

  it("resolves a token to its principal", () => {
    const s = store();
    const registered = s.registerDevice("phone");
    expect(s.resolve(registered.token)).toEqual({
      userId: registered.userId,
      deviceId: registered.deviceId,
    });
  });

  it("rejects an unknown token", () => {
    expect(store().resolve("not-a-real-token")).toBeNull();
  });

  it("rejects a missing token", () => {
    expect(store().resolve(undefined)).toBeNull();
  });

  it("rejects an empty token", () => {
    expect(store().resolve("")).toBeNull();
  });

  it("never stores the plaintext token", () => {
    const db = openDb(":memory:");
    const registered = new IdentityStore(db).registerDevice("mac");
    const rows = db.prepare("SELECT token_hash FROM devices").all();
    expect(rows).toHaveLength(1);
    expect((rows[0] as { token_hash: string }).token_hash).not.toBe(registered.token);
  });

  it("adds a second device to an existing user", () => {
    const s = store();
    const phone = s.registerDevice("phone");
    const mac = s.addDeviceToUser(phone.userId, "mac");
    expect(mac.userId).toBe(phone.userId);
    expect(s.resolve(mac.token)).toEqual({ userId: phone.userId, deviceId: mac.deviceId });
  });
});

describe("devices table constraints", () => {
  // These constraints (CHECK on kind, UNIQUE on token_hash) come from Task 1's
  // schema and aren't reachable through IdentityStore's public API — kind is
  // typed as DeviceKind so nothing outside the type system can pass a bad
  // value, and token_hash collisions can't be manufactured through
  // registerDevice/addDeviceToUser since tokens are random. So these are
  // tested directly against the database, the same level db.test.ts already
  // tests the foreign-key constraint at.
  it("rejects a device kind outside the allowed set", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO users (id, created_at) VALUES (?, ?)").run(
      "u1",
      "2026-08-14T00:00:00Z",
    );
    expect(() =>
      db
        .prepare(
          "INSERT INTO devices (id, user_id, kind, token_hash, created_at) VALUES (?,?,?,?,?)",
        )
        .run(randomUUID(), "u1", "toaster", "hash1", "2026-08-14T00:00:00Z"),
    ).toThrow();
  });

  it("rejects two devices sharing a token_hash", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO users (id, created_at) VALUES (?, ?)").run(
      "u1",
      "2026-08-14T00:00:00Z",
    );
    db.prepare(
      "INSERT INTO devices (id, user_id, kind, token_hash, created_at) VALUES (?,?,?,?,?)",
    ).run(randomUUID(), "u1", "watch", "shared-hash", "2026-08-14T00:00:00Z");
    expect(() =>
      db
        .prepare(
          "INSERT INTO devices (id, user_id, kind, token_hash, created_at) VALUES (?,?,?,?,?)",
        )
        .run(randomUUID(), "u1", "phone", "shared-hash", "2026-08-14T00:00:00Z"),
    ).toThrow();
  });
});
