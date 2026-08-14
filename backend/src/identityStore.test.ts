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

describe("last_seen_at throttling", () => {
  function lastSeenOf(db: ReturnType<typeof openDb>, deviceId: string): string | null {
    const row = db
      .prepare("SELECT last_seen_at FROM devices WHERE id = ?")
      .get(deviceId) as { last_seen_at: string | null };
    return row.last_seen_at;
  }

  it("does not rewrite last_seen_at on a resolve shortly after the first", () => {
    let clock = 1_000_000;
    const db = openDb(":memory:");
    const s = new IdentityStore(db, { now: () => clock });
    const registered = s.registerDevice("phone");

    s.resolve(registered.token);
    const first = lastSeenOf(db, registered.deviceId);

    clock += 60_000; // 1 minute later, well inside the 5-minute window
    s.resolve(registered.token);
    const second = lastSeenOf(db, registered.deviceId);

    expect(second).toBe(first);
  });

  it("rewrites last_seen_at once the throttle window has passed", () => {
    let clock = 1_000_000;
    const db = openDb(":memory:");
    const s = new IdentityStore(db, { now: () => clock });
    const registered = s.registerDevice("phone");

    s.resolve(registered.token);
    const first = lastSeenOf(db, registered.deviceId);

    clock += 5 * 60_000 + 1; // just past the 5-minute throttle window
    s.resolve(registered.token);
    const second = lastSeenOf(db, registered.deviceId);

    expect(second).not.toBe(first);
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

describe("IdentityStore pairing", () => {
  it("issues a six-digit code", () => {
    const s = store();
    const phone = s.registerDevice("phone");
    const { code } = s.issuePairingCode(phone.userId);
    expect(code).toMatch(/^\d{6}$/);
  });

  it("frees an expired code's value for reuse", () => {
    const db = openDb(":memory:");
    const s = new IdentityStore(db);
    const phone = s.registerDevice("phone");
    // A row that lived past its expiry but was never claimed — dead, but
    // still occupying its code value under the old, unfiltered collision
    // check.
    db.prepare("INSERT INTO pairing_codes (code, user_id, expires_at) VALUES (?,?,?)").run(
      "555555",
      phone.userId,
      "2000-01-01T00:00:00.000Z",
    );

    s.issuePairingCode(phone.userId);

    const stillThere = db
      .prepare("SELECT code FROM pairing_codes WHERE code = ?")
      .get("555555");
    expect(stillThere).toBeUndefined();
  });

  it("purges dead rows when issuing a new code", () => {
    const db = openDb(":memory:");
    const s = new IdentityStore(db);
    const phone = s.registerDevice("phone");
    // One consumed row and one expired-but-unconsumed row: both are dead.
    db.prepare(
      "INSERT INTO pairing_codes (code, user_id, expires_at, consumed_at) VALUES (?,?,?,?)",
    ).run("111111", phone.userId, "2099-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z");
    db.prepare("INSERT INTO pairing_codes (code, user_id, expires_at) VALUES (?,?,?)").run(
      "222222",
      phone.userId,
      "2000-01-01T00:00:00.000Z",
    );

    s.issuePairingCode(phone.userId);

    const rows = db.prepare("SELECT code FROM pairing_codes").all();
    expect(rows).toHaveLength(1);
  });

  it("moves the claiming device to the issuing user", () => {
    const s = store();
    const phone = s.registerDevice("phone");
    const watch = s.registerDevice("watch");
    const { code } = s.issuePairingCode(phone.userId);

    const result = s.claimPairingCode(code, {
      userId: watch.userId,
      deviceId: watch.deviceId,
    });

    expect(result).toEqual({ ok: true, fromUserId: watch.userId, toUserId: phone.userId });
    expect(s.resolve(watch.token)).toEqual({
      userId: phone.userId,
      deviceId: watch.deviceId,
    });
  });

  it("keeps the claiming device's token working after the merge", () => {
    const s = store();
    const phone = s.registerDevice("phone");
    const watch = s.registerDevice("watch");
    s.claimPairingCode(s.issuePairingCode(phone.userId).code, {
      userId: watch.userId,
      deviceId: watch.deviceId,
    });
    expect(s.resolve(watch.token)).not.toBeNull();
  });

  it("deletes the orphaned user", () => {
    const db = openDb(":memory:");
    const s = new IdentityStore(db);
    const phone = s.registerDevice("phone");
    const watch = s.registerDevice("watch");
    s.claimPairingCode(s.issuePairingCode(phone.userId).code, {
      userId: watch.userId,
      deviceId: watch.deviceId,
    });
    const remaining = db.prepare("SELECT id FROM users").all();
    expect(remaining).toHaveLength(1);
    expect((remaining[0] as { id: string }).id).toBe(phone.userId);
  });

  it("rejects an unknown code", () => {
    const s = store();
    const watch = s.registerDevice("watch");
    expect(
      s.claimPairingCode("000000", { userId: watch.userId, deviceId: watch.deviceId }),
    ).toEqual({ ok: false, reason: "unknown" });
  });

  it("rejects a code that was already claimed", () => {
    const s = store();
    const phone = s.registerDevice("phone");
    const first = s.registerDevice("watch");
    const second = s.registerDevice("mac");
    const { code } = s.issuePairingCode(phone.userId);
    s.claimPairingCode(code, { userId: first.userId, deviceId: first.deviceId });
    expect(
      s.claimPairingCode(code, { userId: second.userId, deviceId: second.deviceId }),
    ).toEqual({ ok: false, reason: "consumed" });
  });

  it("rejects an expired code", () => {
    let clock = 1_000_000;
    const s = new IdentityStore(openDb(":memory:"), { now: () => clock });
    const phone = s.registerDevice("phone");
    const watch = s.registerDevice("watch");
    const { code } = s.issuePairingCode(phone.userId);
    clock += 11 * 60_000;
    expect(
      s.claimPairingCode(code, { userId: watch.userId, deviceId: watch.deviceId }),
    ).toEqual({ ok: false, reason: "expired" });
  });

  it("treats claiming one's own code as a no-op success", () => {
    const s = store();
    const phone = s.registerDevice("phone");
    const { code } = s.issuePairingCode(phone.userId);
    expect(
      s.claimPairingCode(code, { userId: phone.userId, deviceId: phone.deviceId }),
    ).toEqual({ ok: true, fromUserId: phone.userId, toUserId: phone.userId });
    expect(s.resolve(phone.token)).not.toBeNull();
  });
});
