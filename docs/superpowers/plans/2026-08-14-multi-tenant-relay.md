# Multi-Tenant Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the caption relay multi-tenant — every session, transcript, and presence record belongs to exactly one user, authenticated by a per-device token rather than one shared secret compiled into every app build.

**Architecture:** A SQLite database (via Node's built-in `node:sqlite`) holds users, devices, and pairing codes. Each app self-registers on first launch and receives an opaque bearer token; the server stores only its SHA-256. Every request resolves that token to a `Principal { userId, deviceId }`, and that `userId` is threaded into the session, transcript, and presence stores. Phone and watch register as separate users and are merged by a six-digit pairing code.

**Tech Stack:** Node 24+ (ESM), TypeScript, `node:sqlite` (`DatabaseSync`), `node:crypto`, vitest. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-08-14-multi-tenancy-and-exports-design.md`

## Global Constraints

- **No new npm dependencies.** SQLite comes from the Node standard library (`node:sqlite`), not `better-sqlite3`. This avoids a native module and its Docker build-tooling requirements.
- **Node 24 minimum.** `node:sqlite` is unflagged from Node 23.4 onward. The Dockerfile currently pins `node:20-slim` and must move to `node:24-slim` (Task 12).
- **`node:sqlite` returns null-prototype row objects.** Always spread rows into plain objects (`{ ...row }`) at the store boundary before returning them, so callers and `toEqual` assertions behave normally.
- **ESM, no file extensions in relative imports** — match the existing style, e.g. `import { verifyToken } from "./auth"`.
- **Tests are colocated** as `src/<module>.test.ts` and run with `npm test` (`vitest run`).
- **Token format:** 32 random bytes, `base64url`. **Stored form:** lowercase hex SHA-256. The plaintext token is returned to the client exactly once, at registration.
- **IDs** are `randomUUID()`.
- Type check with `npm run build` (`tsc --noEmit`) before every commit.

## Scope

This plan implements sections 3, 4, and 5 of the spec, and steps 1–6 of its order of work. Two follow-on plans complete the spec:

- **Plan 2 — per-user export destinations** (spec section 6, steps 7–8).
- **Plan 3 — client changes** (spec section 7, steps 9–13). Blocked on the paid Apple Developer Program membership.

## File Structure

**Created:**
- `src/db.ts` — opens the database and applies the schema. Nothing else.
- `src/db.test.ts`
- `src/identityStore.ts` — users, devices, pairing codes. The only module that knows the schema exists.
- `src/identityStore.test.ts`
- `src/tenantMigration.ts` — one-shot move of flat-root transcripts under a user directory.
- `src/tenantMigration.test.ts`
- `src/server.tenancy.test.ts` — cross-tenant isolation tests spanning routes.

**Modified:**
- `src/auth.ts` — `verifyToken` replaced by `resolveToken` and `bearerToken`.
- `src/auth.test.ts` — rewritten.
- `src/server.ts` — every route resolves a `Principal`; new registration and pairing routes; per-session provider param; settings routes deleted.
- `src/sessionStore.ts` — keyed by `${userId}:${sessionId}`.
- `src/transcriptStore.ts` — per-user directories.
- `src/finalizer.ts` — `dir` becomes `root`; the per-user directory is derived from `t.userId`.
- `src/readerPresence.ts` — keyed by user and session.
- `src/index.ts` — opens the database, runs the migration, wires the identity store.
- `src/config.ts` — `AUTH_TOKEN` removed, `ADMIN_TOKEN` and `DB_PATH` added.
- `src/viewerPage.ts` — token moves to an `Authorization` header.
- `Dockerfile` — `node:20-slim` → `node:24-slim`.

**Deleted:**
- `src/settings.ts`, `src/settings.test.ts`
- `src/settingsStore.ts`, `src/settingsStore.test.ts`
- `src/server.settings.test.ts`

---

### Task 1: Database module and schema

**Files:**
- Create: `backend/src/db.ts`
- Test: `backend/src/db.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type Db = DatabaseSync`, `function openDb(path: string): Db`. `":memory:"` is a valid path and is what tests use.

- [ ] **Step 1: Write the failing test**

Create `backend/src/db.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { openDb } from "./db";

describe("openDb", () => {
  it("creates the identity tables", () => {
    const db = openDb(":memory:");
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(names).toContain("users");
    expect(names).toContain("devices");
    expect(names).toContain("pairing_codes");
  });

  it("enforces foreign keys", () => {
    const db = openDb(":memory:");
    expect(() =>
      db
        .prepare("INSERT INTO devices (id, user_id, kind, token_hash, created_at) VALUES (?,?,?,?,?)")
        .run("d1", "nonexistent-user", "watch", "hash", "2026-08-14T00:00:00Z"),
    ).toThrow();
  });

  it("is idempotent when reopened", () => {
    const db = openDb(":memory:");
    expect(() => openDb(":memory:")).not.toThrow();
    expect(db.prepare("SELECT count(*) AS n FROM users").get()).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/db.test.ts`
Expected: FAIL — `Cannot find module './db'`

- [ ] **Step 3: Write minimal implementation**

Create `backend/src/db.ts`:

```ts
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

/**
 * Opens the identity database and brings its schema up to date.
 *
 * SQLite comes from the Node standard library rather than `better-sqlite3`:
 * a native module would need build tooling in the production image, and the
 * only thing this database is asked to do — a handful of indexed lookups per
 * request — is squarely within what the built-in driver handles.
 *
 * Pass `":memory:"` in tests.
 */
export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  // Off by default in SQLite. Without it the ON DELETE CASCADE below is
  // decorative and deleting a user would strand its devices.
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id          TEXT PRIMARY KEY,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS devices (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind          TEXT NOT NULL CHECK (kind IN ('watch','phone','mac')),
      token_hash    TEXT NOT NULL UNIQUE,
      created_at    TEXT NOT NULL,
      last_seen_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS devices_user ON devices(user_id);

    CREATE TABLE IF NOT EXISTS pairing_codes (
      code        TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at  TEXT NOT NULL,
      consumed_at TEXT
    );
  `);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/db.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 5: Verify the type check is clean**

Run: `cd backend && npm run build`
Expected: no output, exit 0

- [ ] **Step 6: Commit**

```bash
git add backend/src/db.ts backend/src/db.test.ts
git commit -m "feat(relay): identity database schema"
```

---

### Task 2: Device registration and token resolution

**Files:**
- Create: `backend/src/identityStore.ts`
- Test: `backend/src/identityStore.test.ts`

**Interfaces:**
- Consumes: `openDb`, `Db` from Task 1.
- Produces:
  - `interface Principal { userId: string; deviceId: string }`
  - `type DeviceKind = "watch" | "phone" | "mac"`
  - `interface RegisteredDevice { deviceId: string; userId: string; token: string }`
  - `class IdentityStore` with `constructor(db: Db, opts?: { now?: () => number })`, `registerDevice(kind: DeviceKind): RegisteredDevice`, `resolve(token: string | undefined): Principal | null`, `addDeviceToUser(userId: string, kind: DeviceKind): RegisteredDevice`.

- [ ] **Step 1: Write the failing test**

Create `backend/src/identityStore.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/identityStore.test.ts`
Expected: FAIL — `Cannot find module './identityStore'`

- [ ] **Step 3: Write minimal implementation**

Create `backend/src/identityStore.ts`:

```ts
import { randomUUID, randomBytes, createHash } from "crypto";
import { Db } from "./db";

export interface Principal {
  userId: string;
  deviceId: string;
}

export type DeviceKind = "watch" | "phone" | "mac";

export interface RegisteredDevice {
  deviceId: string;
  userId: string;
  /** The plaintext token. Returned once, at registration, and never stored. */
  token: string;
}

export interface IdentityStoreOptions {
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
}

/**
 * Users, devices, and the pairing codes that merge them.
 *
 * Devices authenticate with an opaque bearer token of which only a SHA-256 is
 * kept, so a database leak yields no working credentials. There is no password
 * and no sign-in: an app registers itself on first launch, which is what keeps
 * the setup burden off an audience that should not have to manage an account.
 */
export class IdentityStore {
  private readonly now: () => number;

  constructor(
    private readonly db: Db,
    opts: IdentityStoreOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** Create a brand-new user owning a single fresh device. */
  registerDevice(kind: DeviceKind): RegisteredDevice {
    const userId = randomUUID();
    this.db
      .prepare("INSERT INTO users (id, created_at) VALUES (?, ?)")
      .run(userId, this.timestamp());
    return this.addDeviceToUser(userId, kind);
  }

  /** Attach another device to a user that already exists. */
  addDeviceToUser(userId: string, kind: DeviceKind): RegisteredDevice {
    const deviceId = randomUUID();
    const token = randomBytes(32).toString("base64url");
    this.db
      .prepare(
        "INSERT INTO devices (id, user_id, kind, token_hash, created_at) VALUES (?,?,?,?,?)",
      )
      .run(deviceId, userId, kind, hashToken(token), this.timestamp());
    return { deviceId, userId, token };
  }

  /**
   * The principal a token belongs to, or null. Also stamps `last_seen_at`,
   * which is the only liveness signal available for a device that holds no
   * connection open.
   */
  resolve(token: string | undefined): Principal | null {
    if (!token) return null;
    const row = this.db
      .prepare("SELECT id, user_id FROM devices WHERE token_hash = ?")
      .get(hashToken(token)) as { id: string; user_id: string } | undefined;
    if (!row) return null;
    this.db
      .prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?")
      .run(this.timestamp(), row.id);
    return { userId: row.user_id, deviceId: row.id };
  }

  protected timestamp(): string {
    return new Date(this.now()).toISOString();
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/identityStore.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Verify the type check is clean**

Run: `cd backend && npm run build`
Expected: no output, exit 0

- [ ] **Step 6: Commit**

```bash
git add backend/src/identityStore.ts backend/src/identityStore.test.ts
git commit -m "feat(relay): per-device registration and token resolution"
```

---

### Task 3: Pairing codes

**Files:**
- Modify: `backend/src/identityStore.ts`
- Test: `backend/src/identityStore.test.ts`

**Interfaces:**
- Consumes: `IdentityStore` from Task 2.
- Produces, added to `IdentityStore`:
  - `issuePairingCode(userId: string): { code: string; expiresAt: string }`
  - `claimPairingCode(code: string, claimant: Principal): ClaimResult`
  - `type ClaimResult = { ok: true; fromUserId: string; toUserId: string } | { ok: false; reason: "unknown" | "expired" | "consumed" }`
  - `export const PAIRING_CODE_TTL_MS = 10 * 60_000`

`fromUserId === toUserId` signals a self-claim, which succeeds and changes nothing. The caller uses `fromUserId` to move that user's transcripts (Task 10); the store does no filesystem work.

- [ ] **Step 1: Write the failing test**

Append to `backend/src/identityStore.test.ts`:

```ts
describe("IdentityStore pairing", () => {
  it("issues a six-digit code", () => {
    const s = store();
    const phone = s.registerDevice("phone");
    const { code } = s.issuePairingCode(phone.userId);
    expect(code).toMatch(/^\d{6}$/);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/identityStore.test.ts`
Expected: FAIL — `s.issuePairingCode is not a function`

- [ ] **Step 3: Write minimal implementation**

Add to `backend/src/identityStore.ts` — the import line becomes:

```ts
import { randomUUID, randomBytes, createHash, randomInt } from "crypto";
```

Add the exported type and constant above the class:

```ts
export type ClaimResult =
  | { ok: true; fromUserId: string; toUserId: string }
  | { ok: false; reason: "unknown" | "expired" | "consumed" };

/** How long a pairing code stays claimable. */
export const PAIRING_CODE_TTL_MS = 10 * 60_000;
```

Add these methods inside `IdentityStore`, before `timestamp()`:

```ts
  /**
   * A short code the user reads off the phone and types on the watch.
   *
   * Six digits rather than something longer because it is entered with a
   * Digital Crown, one digit at a time. The short TTL is what makes that
   * length safe: 10 minutes of a single-use code is not a guessable target.
   */
  issuePairingCode(userId: string): { code: string; expiresAt: string } {
    const expiresAt = new Date(this.now() + PAIRING_CODE_TTL_MS).toISOString();
    // Retry on the astronomically unlikely collision with a live code rather
    // than letting the unique constraint surface as a 500.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      const existing = this.db
        .prepare("SELECT code FROM pairing_codes WHERE code = ?")
        .get(code);
      if (existing) continue;
      this.db
        .prepare("INSERT INTO pairing_codes (code, user_id, expires_at) VALUES (?,?,?)")
        .run(code, userId, expiresAt);
      return { code, expiresAt };
    }
    throw new Error("could not allocate a pairing code");
  }

  /**
   * Move the claiming device onto the code's user and retire the user it came
   * from. The device's token is untouched — only what it resolves to changes,
   * so a watch mid-pairing never has to accept a new credential over a channel
   * it cannot report a failure on.
   *
   * Returns the two user ids so the caller can move the abandoned user's
   * transcripts. This store does no filesystem work.
   */
  claimPairingCode(code: string, claimant: Principal): ClaimResult {
    const row = this.db
      .prepare("SELECT user_id, expires_at, consumed_at FROM pairing_codes WHERE code = ?")
      .get(code) as
      | { user_id: string; expires_at: string; consumed_at: string | null }
      | undefined;

    if (!row) return { ok: false, reason: "unknown" };
    if (row.consumed_at) return { ok: false, reason: "consumed" };
    if (Date.parse(row.expires_at) <= this.now()) return { ok: false, reason: "expired" };

    const toUserId = row.user_id;
    const fromUserId = claimant.userId;
    const stamp = this.timestamp();

    if (fromUserId === toUserId) {
      this.db
        .prepare("UPDATE pairing_codes SET consumed_at = ? WHERE code = ?")
        .run(stamp, code);
      return { ok: true, fromUserId, toUserId };
    }

    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("UPDATE devices SET user_id = ? WHERE id = ?")
        .run(toUserId, claimant.deviceId);
      this.db
        .prepare("UPDATE pairing_codes SET consumed_at = ? WHERE code = ?")
        .run(stamp, code);
      // Any device still on the old user keeps it alive; only a user with
      // nothing left pointing at it is deleted.
      const remaining = this.db
        .prepare("SELECT count(*) AS n FROM devices WHERE user_id = ?")
        .get(fromUserId) as { n: number };
      if (remaining.n === 0) {
        this.db.prepare("DELETE FROM users WHERE id = ?").run(fromUserId);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    return { ok: true, fromUserId, toUserId };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/identityStore.test.ts`
Expected: PASS, 15 tests

- [ ] **Step 5: Verify the type check is clean**

Run: `cd backend && npm run build`
Expected: no output, exit 0

- [ ] **Step 6: Commit**

```bash
git add backend/src/identityStore.ts backend/src/identityStore.test.ts
git commit -m "feat(relay): pairing codes merge a watch into a phone's account"
```

---

### Task 4: Replace `verifyToken` with `resolveToken`

**Files:**
- Modify: `backend/src/auth.ts` (full rewrite)
- Test: `backend/src/auth.test.ts` (full rewrite)

**Interfaces:**
- Consumes: `IdentityStore`, `Principal` from Task 2.
- Produces:
  - `function bearerToken(header: string | undefined): string | undefined`
  - `function resolveToken(identity: IdentityStore, token: string | undefined): Principal | null`

`bearerToken` parses an `Authorization` header value. It is case-insensitive on the scheme and tolerates extra whitespace, because that is what HTTP clients actually send.

- [ ] **Step 1: Write the failing test**

Replace the contents of `backend/src/auth.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/auth.test.ts`
Expected: FAIL — `bearerToken is not exported`

- [ ] **Step 3: Write minimal implementation**

Replace the contents of `backend/src/auth.ts`:

```ts
import { IdentityStore, Principal } from "./identityStore";

/**
 * The token from an `Authorization: Bearer …` header, if there is one.
 *
 * Tokens moved out of the query string when they stopped being one shared
 * development secret and became a per-user credential: query strings are
 * recorded in access logs, proxy logs, and `Referer` headers.
 */
export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^\s*bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1];
}

/** The principal a token belongs to, or null when it belongs to nobody. */
export function resolveToken(
  identity: IdentityStore,
  token: string | undefined,
): Principal | null {
  return identity.resolve(token);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/auth.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 5: Confirm the rest of the suite now fails to compile**

Run: `cd backend && npm run build`
Expected: FAIL — `server.ts` still imports `verifyToken`. This is expected; Task 6 fixes it. Do not fix it here.

- [ ] **Step 6: Commit**

```bash
git add backend/src/auth.ts backend/src/auth.test.ts
git commit -m "feat(relay): resolve bearer tokens to a principal"
```

---

### Task 5: `POST /v1/devices` registration endpoint

**Files:**
- Modify: `backend/src/server.ts`
- Test: `backend/src/server.devices.test.ts` (create)

**Interfaces:**
- Consumes: `IdentityStore` (Task 2), `bearerToken` (Task 4).
- Produces: `StartServerOptions` gains `identity: IdentityStore` and loses `authToken`. New route `POST /v1/devices`.

Registration is deliberately unauthenticated — an app has no credential before it registers. A per-IP limit of 10 registrations per hour bounds the abuse, which is proportionate while a free account grants no metered cloud usage.

- [ ] **Step 1: Write the failing test**

Create `backend/src/server.devices.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { startServer, CaptionServer } from "./server";
import { IdentityStore } from "./identityStore";
import { openDb } from "./db";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";

let server: CaptionServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function start(): { port: number; identity: IdentityStore } {
  const identity = new IdentityStore(openDb(":memory:"));
  server = startServer({
    port: 0,
    identity,
    createProvider: () => new FakeTranscriptionProvider(),
  });
  const addr = server.address();
  return { port: typeof addr === "object" && addr ? addr.port : 0, identity };
}

describe("POST /v1/devices", () => {
  it("registers a device and returns a usable token", async () => {
    const { port, identity } = start();
    const res = await fetch(`http://127.0.0.1:${port}/v1/devices`, {
      method: "POST",
      body: JSON.stringify({ kind: "watch" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deviceId: string; userId: string; token: string };
    expect(identity.resolve(body.token)).toEqual({
      userId: body.userId,
      deviceId: body.deviceId,
    });
  });

  it("rejects an unknown device kind", async () => {
    const { port } = start();
    const res = await fetch(`http://127.0.0.1:${port}/v1/devices`, {
      method: "POST",
      body: JSON.stringify({ kind: "toaster" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a malformed body", async () => {
    const { port } = start();
    const res = await fetch(`http://127.0.0.1:${port}/v1/devices`, {
      method: "POST",
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("rate limits repeated registrations from one address", async () => {
    const { port } = start();
    const codes: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const res = await fetch(`http://127.0.0.1:${port}/v1/devices`, {
        method: "POST",
        body: JSON.stringify({ kind: "watch" }),
      });
      codes.push(res.status);
    }
    expect(codes.filter((c) => c === 200)).toHaveLength(10);
    expect(codes.filter((c) => c === 429)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/server.devices.test.ts`
Expected: FAIL — `identity` is not a valid option / route returns 404

- [ ] **Step 3: Write minimal implementation**

In `backend/src/server.ts`, replace the `verifyToken` import:

```ts
import { bearerToken, resolveToken } from "./auth";
import { IdentityStore, DeviceKind, Principal } from "./identityStore";
```

In `StartServerOptions`, delete `authToken: string;` and add:

```ts
  /** Users, devices, and pairing codes. */
  identity: IdentityStore;
```

Add these constants next to `MAX_AUDIO_BYTES`:

```ts
/** A registration body is `{"kind":"watch"}`; anything larger is not one. */
const MAX_REGISTRATION_BYTES = 1024;
const DEVICE_KINDS: DeviceKind[] = ["watch", "phone", "mac"];
/** Registrations allowed per address per window, and the window itself. */
const REGISTRATIONS_PER_WINDOW = 10;
const REGISTRATION_WINDOW_MS = 60 * 60_000;
```

Add this class above `startServer`:

```ts
/**
 * Per-address registration limiter.
 *
 * Registration cannot require a credential — an app has none before it
 * registers — so the only backstop is a rate limit. A junk account costs one
 * table row today; this must be revisited before a free account grants any
 * metered cloud usage.
 */
class RegistrationLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  allow(address: string): boolean {
    const cutoff = this.now() - REGISTRATION_WINDOW_MS;
    const recent = (this.hits.get(address) ?? []).filter((at) => at > cutoff);
    if (recent.length >= REGISTRATIONS_PER_WINDOW) {
      this.hits.set(address, recent);
      return false;
    }
    recent.push(this.now());
    this.hits.set(address, recent);
    return true;
  }
}
```

In `startServer`, create the limiter beside the other collaborators and pass it into `handleRequest`:

```ts
  const limiter = new RegistrationLimiter();
```

Change the `handleRequest` call and signature to carry `limiter` instead of `settings` (settings are removed entirely in Task 11; for now keep the `settings` parameter and add `limiter` after it).

Add the route in `handleRequest`, immediately after the `/app` block:

```ts
  // An app registers itself on first launch. Unauthenticated by necessity:
  // there is no credential to present until this call issues one.
  if (req.method === "POST" && url.pathname === "/v1/devices") {
    const address = req.socket.remoteAddress ?? "unknown";
    if (!limiter.allow(address)) {
      sendJSON(res, 429, { error: "too many registrations" });
      return;
    }
    let body: Buffer;
    try {
      body = await readBody(req, MAX_REGISTRATION_BYTES);
    } catch {
      sendJSON(res, 413, { error: "body too large" });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      sendJSON(res, 400, { error: "invalid json" });
      return;
    }
    const kind = (parsed as { kind?: unknown } | null)?.kind;
    if (!DEVICE_KINDS.includes(kind as DeviceKind)) {
      sendJSON(res, 400, { error: "unknown device kind" });
      return;
    }
    sendJSON(res, 200, opts.identity.registerDevice(kind as DeviceKind));
    return;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/server.devices.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add backend/src/server.ts backend/src/server.devices.test.ts
git commit -m "feat(relay): device registration endpoint"
```

---

### Task 6: Resolve a principal on every authenticated route

**Files:**
- Modify: `backend/src/server.ts`
- Modify: `backend/src/viewerPage.ts:70`
- Modify: `backend/src/server.test.ts`, `backend/src/server.http.test.ts`, `backend/src/server.call.test.ts`, `backend/src/server.presence.test.ts`, `backend/src/server.transcripts.test.ts`, `backend/src/server.usage.test.ts`

**Interfaces:**
- Consumes: `resolveToken`, `bearerToken` (Task 4); `identity` option (Task 5).
- Produces: a local helper `principalFor(req, url, opts): Principal | null` used by every authenticated route. `userId` is available at every call site for Tasks 7–9 to consume.

This task changes authentication only. It does **not** yet scope any store — every route still calls the stores exactly as before. Splitting it this way keeps a large mechanical change reviewable on its own.

- [ ] **Step 1: Add the helper and convert one route, with its test**

Add to `backend/src/server.ts`, near `sendJSON`:

```ts
/**
 * The principal behind a request.
 *
 * The header is the real channel. The query string is still read for the two
 * cases that cannot send a header: Twilio's media-stream client, which drops
 * the query string and gets its token from the path instead, and its webhooks,
 * which we do not control.
 */
function principalFor(
  req: IncomingMessage,
  url: URL,
  opts: StartServerOptions,
): Principal | null {
  const header = bearerToken(req.headers.authorization);
  const token = header ?? url.searchParams.get("token") ?? undefined;
  return resolveToken(opts.identity, token);
}
```

Convert the `/v1/usage` route as the first case, and additionally gate it on the admin token:

```ts
  if (req.method === "GET" && url.pathname === "/v1/usage") {
    if (!opts.usage) {
      sendJSON(res, 404, { error: "usage not enabled" });
      return;
    }
    // This reports the operator's Deepgram and Fly bill, not a per-user
    // figure, so a device token must not reach it.
    const token = bearerToken(req.headers.authorization) ?? url.searchParams.get("token");
    if (!opts.adminToken || token !== opts.adminToken) {
      sendJSON(res, 401, { error: "unauthorized" });
      return;
    }
    try {
      sendJSON(res, 200, await opts.usage.getUsage());
    } catch {
      sendJSON(res, 500, { error: "usage fetch failed" });
    }
    return;
  }
```

Add to `StartServerOptions`:

```ts
  /** Operator-only token for /v1/usage. Without it the endpoint is closed. */
  adminToken?: string;
```

- [ ] **Step 2: Run the usage tests to verify they fail**

Run: `cd backend && npx vitest run src/server.usage.test.ts`
Expected: FAIL — existing tests pass a device-style token and now get 401

- [ ] **Step 3: Update `server.usage.test.ts` to pass an admin token**

In that file, add `adminToken: "admin-secret"` to the `startServer` options and send `Authorization: Bearer admin-secret` on requests that should succeed. Add one new case:

```ts
  it("rejects a device token", async () => {
    const registered = identity.registerDevice("mac");
    const res = await fetch(`http://127.0.0.1:${port}/v1/usage`, {
      headers: { authorization: `Bearer ${registered.token}` },
    });
    expect(res.status).toBe(401);
  });
```

- [ ] **Step 4: Run the usage tests to verify they pass**

Run: `cd backend && npx vitest run src/server.usage.test.ts`
Expected: PASS

- [ ] **Step 5: Convert every remaining authenticated route**

Replace each occurrence of this pattern:

```ts
    const token = url.searchParams.get("token") ?? undefined;
    if (!verifyToken(token, opts.authToken)) {
      sendJSON(res, 401, { error: "unauthorized" });
      return;
    }
```

with:

```ts
    const principal = principalFor(req, url, opts);
    if (!principal) {
      sendJSON(res, 401, { error: "unauthorized" });
      return;
    }
```

Apply to: `/twilio/voice`, `/twilio/stream-status`, `/v1/call`, `/v1/presence`, `/v1/settings`, `/v1/transcripts` (both GET and DELETE), and `/v1/audio` / `/v1/stop`.

In the upgrade handler, replace both `verifyToken(...)` calls with `resolveToken(opts.identity, ...)` and test for `null`:

```ts
      if (!resolveToken(opts.identity, fromPath ?? token)) {
```

and

```ts
    if (!resolveToken(opts.identity, token)) {
```

- [ ] **Step 6: Update the viewer to send a header**

In `backend/src/viewerPage.ts`, change line 70 from:

```js
  const res = await fetch(path + sep + 'token=' + encodeURIComponent(token));
```

to:

```js
  const res = await fetch(path, { headers: { authorization: 'Bearer ' + token } });
```

Then delete the now-unused `sep` variable on the preceding lines if it becomes dead.

- [ ] **Step 7: Update the remaining server test files**

In each of `server.test.ts`, `server.http.test.ts`, `server.call.test.ts`, `server.presence.test.ts`, `server.transcripts.test.ts`: replace the `authToken: "<something>"` option with `identity`, register a device in setup, and send `Authorization: Bearer <token>` instead of `?token=`. Example of the setup change:

```ts
const identity = new IdentityStore(openDb(":memory:"));
const device = identity.registerDevice("watch");
server = startServer({ port: 0, identity, createProvider: () => new FakeTranscriptionProvider() });
```

and of a request:

```ts
await fetch(`http://127.0.0.1:${port}/v1/audio?session=s1`, {
  method: "POST",
  headers: { authorization: `Bearer ${device.token}` },
  body: pcm,
});
```

- [ ] **Step 8: Run the full suite**

Run: `cd backend && npm test`
Expected: PASS. `npm run build` should also now be clean, since nothing imports `verifyToken` any more.

- [ ] **Step 9: Commit**

```bash
git add backend/src backend/src/viewerPage.ts
git commit -m "feat(relay): authenticate every route against a device principal"
```

---

### Task 7: Scope sessions by user

**Files:**
- Modify: `backend/src/sessionStore.ts`
- Modify: `backend/src/server.ts`
- Test: `backend/src/sessionStore.test.ts`, `backend/src/server.tenancy.test.ts` (create)

**Interfaces:**
- Consumes: `Principal` from every route (Task 6).
- Produces: every `SessionStore` method takes `userId` as its first parameter — `feed(userId, id, pcm, ephemeral?, providerOpts?)`, `drain(userId, id, since)`, `has(userId, id)`, `stop(userId, id)`, `isEphemeral(userId, id)`. `reapIdle()`, `closeAll()` are unchanged.

This is the live-caption breach: today a guessed session id reads a stranger's captions.

- [ ] **Step 1: Write the failing test**

Add to `backend/src/sessionStore.test.ts`:

```ts
  it("keeps identically named sessions from different users apart", () => {
    const store = new SessionStore({ createProvider: () => new FakeTranscriptionProvider() });
    store.feed("user-a", "shared-id", Buffer.from([1, 2, 3, 4]));
    expect(store.has("user-a", "shared-id")).toBe(true);
    expect(store.has("user-b", "shared-id")).toBe(false);
  });

  it("does not drain another user's events", () => {
    const store = new SessionStore({ createProvider: () => new FakeTranscriptionProvider() });
    store.feed("user-a", "shared-id", Buffer.from([1, 2, 3, 4]));
    expect(store.drain("user-b", "shared-id", 0).events).toEqual([]);
  });

  it("does not stop another user's session", () => {
    const store = new SessionStore({ createProvider: () => new FakeTranscriptionProvider() });
    store.feed("user-a", "shared-id", Buffer.from([1, 2, 3, 4]));
    store.stop("user-b", "shared-id");
    expect(store.has("user-a", "shared-id")).toBe(true);
  });
```

Update the file's existing tests to pass a `userId` first argument.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/sessionStore.test.ts`
Expected: FAIL — `Expected 2 arguments, but got 3` / assertions fail

- [ ] **Step 3: Write minimal implementation**

In `backend/src/sessionStore.ts`, add a key helper below the imports:

```ts
/**
 * Sessions are keyed by user as well as id.
 *
 * Session ids are chosen by clients and are not secret — the phone and the
 * watch agree on a fixed one. Keyed by id alone, anyone who guessed one would
 * read that conversation's captions.
 */
function sessionKey(userId: string, id: string): string {
  return `${userId}:${id}`;
}
```

Change each method to take `userId` first and use `sessionKey(userId, id)` wherever `id` indexed `this.sessions`. The transcript calls inside `getOrCreate`, `stop`, `reapIdle`, and `closeAll` must pass `userId` too — those signatures land in Task 8, so for this task pass `userId` through and let `tsc` flag the transcript calls; Task 8 resolves them.

`getOrCreate` gains `userId` and stores it on the `Session` record so `reapIdle` and `closeAll`, which iterate the map, still know whose session they are finalizing:

```ts
interface Session {
  caption: CaptionSession;
  events: SeqEvent[];
  seq: number;
  lastActivity: number;
  ephemeral: boolean;
  /** Kept on the record so the sweeps, which iterate, can finalize correctly. */
  userId: string;
  /** The session id without its user prefix, for the same reason. */
  id: string;
}
```

- [ ] **Step 4: Thread `userId` through the routes**

In `backend/src/server.ts`, every `store.*` call inside a route now passes `principal.userId` first. In `/v1/call`, the session belongs to whoever the call was authenticated as, so use `principal.userId` there too.

- [ ] **Step 5: Write the cross-tenant route test**

Create `backend/src/server.tenancy.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { startServer, CaptionServer } from "./server";
import { IdentityStore } from "./identityStore";
import { openDb } from "./db";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";

let server: CaptionServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("cross-tenant isolation", () => {
  it("does not let one user poll another user's session", async () => {
    const identity = new IdentityStore(openDb(":memory:"));
    const alice = identity.registerDevice("watch");
    const mallory = identity.registerDevice("watch");
    server = startServer({
      port: 0,
      identity,
      createProvider: () => new FakeTranscriptionProvider(),
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    await fetch(`http://127.0.0.1:${port}/v1/audio?session=shared-id`, {
      method: "POST",
      headers: { authorization: `Bearer ${alice.token}` },
      body: Buffer.alloc(3200),
    });

    const res = await fetch(`http://127.0.0.1:${port}/v1/audio?session=shared-id`, {
      method: "POST",
      headers: { authorization: `Bearer ${mallory.token}` },
      body: Buffer.alloc(0),
    });
    const body = (await res.json()) as { events: unknown[]; seq: number };
    expect(body.events).toEqual([]);
    expect(body.seq).toBe(0);
  });
});
```

- [ ] **Step 6: Run the tests**

Run: `cd backend && npx vitest run src/sessionStore.test.ts src/server.tenancy.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add backend/src/sessionStore.ts backend/src/sessionStore.test.ts backend/src/server.ts backend/src/server.tenancy.test.ts
git commit -m "fix(relay): scope live sessions to their owner"
```

---

### Task 8: Scope transcripts by user

**Files:**
- Modify: `backend/src/transcriptStore.ts`
- Modify: `backend/src/finalizer.ts`
- Modify: `backend/src/server.ts`
- Test: `backend/src/transcriptStore.test.ts`, `backend/src/server.tenancy.test.ts`

**Interfaces:**
- Consumes: `userId` from Task 7.
- Produces:
  - `TranscriptStoreOptions.dir` is renamed `root`.
  - `TranscriptStore` methods take `userId` first: `append(userId, sessionId, text, channel?)`, `activeName(userId, sessionId)`, `reopen(userId, sessionId, name)`, `finalize(userId, sessionId)`.
  - `FinalizedTranscript` gains `userId: string`.
  - New export `function userDir(root: string, userId: string): string`.
  - `FinalizerOptions.dir` is renamed `root`.
  - Module-level functions (`listTranscripts`, `readTranscript`, `deleteTranscript`, `writeSummary`, `readExportStatus`, `readExportMarker`, `writeExportMarker`) keep taking a resolved directory. Callers pass `userDir(root, userId)`. This keeps them pure and avoids touching their existing tests beyond the directory they are handed.

- [ ] **Step 1: Write the failing test**

Add to `backend/src/transcriptStore.test.ts`:

```ts
  it("writes each user's transcripts to their own directory", () => {
    const root = mkdtempSync(join(tmpdir(), "wc-"));
    const store = new TranscriptStore({ root });
    store.append("user-a", "s1", "hello from a");
    store.append("user-b", "s1", "hello from b");
    expect(listTranscripts(userDir(root, "user-a"))).toHaveLength(1);
    expect(listTranscripts(userDir(root, "user-b"))).toHaveLength(1);
    expect(listTranscripts(userDir(root, "user-a"))[0].preview).toBe("hello from a");
  });

  it("does not reopen another user's transcript", () => {
    const root = mkdtempSync(join(tmpdir(), "wc-"));
    const store = new TranscriptStore({ root });
    store.append("user-a", "s1", "private");
    const name = store.activeName("user-a", "s1")!;
    store.finalize("user-a", "s1");

    store.reopen("user-b", "s2", name);
    store.append("user-b", "s2", "intruder");
    expect(readTranscript(userDir(root, "user-a"), name)!.segments).toHaveLength(1);
  });

  it("carries the owner on the finalized transcript", () => {
    const root = mkdtempSync(join(tmpdir(), "wc-"));
    const seen: FinalizedTranscript[] = [];
    const store = new TranscriptStore({ root, onFinalize: (t) => seen.push(t) });
    store.append("user-a", "s1", "hello");
    store.finalize("user-a", "s1");
    expect(seen[0].userId).toBe("user-a");
  });
```

Update the file's existing tests: rename `dir` to `root` in constructor calls, add a `userId` first argument to method calls, and pass `userDir(root, userId)` to the module-level functions.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/transcriptStore.test.ts`
Expected: FAIL — `userDir is not exported`

- [ ] **Step 3: Write minimal implementation**

In `backend/src/transcriptStore.ts`:

Add the directory helper and export it:

```ts
/**
 * Where one user's transcripts live.
 *
 * User ids are generated UUIDs, never client-supplied, so they need no
 * sanitizing on the way to the filesystem — unlike transcript names, which
 * `isSafeName` guards.
 */
export function userDir(root: string, userId: string): string {
  return join(root, userId);
}
```

Add `userId` to `FinalizedTranscript`:

```ts
export interface FinalizedTranscript {
  name: string;
  /** Who this transcript belongs to. */
  userId: string;
  sessionId: string;
  startedAt: string;
  endedAt: string;
  segments: TranscriptSegment[];
  resumed?: boolean;
}
```

Rename `TranscriptStoreOptions.dir` to `root`, store it as `this.root`, and key `active` by user as well as session:

```ts
  private active = new Map<string, ActiveTranscript>();

  private key(userId: string, sessionId: string): string {
    return `${userId}:${sessionId}`;
  }
```

Every method takes `userId` first, computes `const dir = userDir(this.root, userId)`, and uses `this.key(userId, sessionId)` for the map. `finalize` passes `userId` into the `onFinalize` payload.

In `backend/src/finalizer.ts`, rename `FinalizerOptions.dir` to `root` and resolve the per-user directory inside `run`:

```ts
async function run(opts: FinalizerOptions, t: FinalizedTranscript): Promise<void> {
  if (!isSubstantial(t)) return;
  const dir = userDir(opts.root, t.userId);
  // …unchanged below, using `dir` where `opts.dir` was used
}
```

Import `userDir` there.

In `backend/src/server.ts`, every module-level transcript call takes `userDir(opts.transcriptsRoot, principal.userId)`. Rename the `transcriptsDir` option to `transcriptsRoot` for the same reason.

- [ ] **Step 4: Add the route-level isolation test**

Append to `backend/src/server.tenancy.test.ts`:

```ts
  it("does not list another user's transcripts", async () => {
    const root = mkdtempSync(join(tmpdir(), "wc-"));
    const identity = new IdentityStore(openDb(":memory:"));
    const alice = identity.registerDevice("watch");
    const mallory = identity.registerDevice("watch");
    const transcripts = new TranscriptStore({ root });
    transcripts.append(
      identity.resolve(alice.token)!.userId,
      "s1",
      "alice's private conversation",
    );

    server = startServer({
      port: 0,
      identity,
      createProvider: () => new FakeTranscriptionProvider(),
      transcripts,
      transcriptsRoot: root,
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    const res = await fetch(`http://127.0.0.1:${port}/v1/transcripts`, {
      headers: { authorization: `Bearer ${mallory.token}` },
    });
    expect((await res.json()) as { transcripts: unknown[] }).toEqual({ transcripts: [] });
  });
```

- [ ] **Step 5: Run the tests**

Run: `cd backend && npx vitest run src/transcriptStore.test.ts src/server.tenancy.test.ts && npm run build`
Expected: PASS, clean type check

- [ ] **Step 6: Commit**

```bash
git add backend/src/transcriptStore.ts backend/src/transcriptStore.test.ts backend/src/finalizer.ts backend/src/server.ts backend/src/server.tenancy.test.ts
git commit -m "fix(relay): give each user their own transcript directory"
```

---

### Task 9: Scope presence by user

**Files:**
- Modify: `backend/src/readerPresence.ts`
- Modify: `backend/src/server.ts`
- Test: `backend/src/readerPresence.test.ts`, `backend/src/server.presence.test.ts`

**Interfaces:**
- Produces: every `ReaderPresence` method takes `userId` first — `mark(userId, sessionId)`, `isPresent(userId, sessionId)`, `markProducer(userId, sessionId)`, `isProducing(userId, sessionId)`, `clear(userId, sessionId)`.

- [ ] **Step 1: Write the failing test**

Add to `backend/src/readerPresence.test.ts`:

```ts
  it("does not report one user's reader as another's", () => {
    const presence = new ReaderPresence();
    presence.mark("user-a", "shared-id");
    expect(presence.isPresent("user-a", "shared-id")).toBe(true);
    expect(presence.isPresent("user-b", "shared-id")).toBe(false);
  });

  it("does not report one user's producer as another's", () => {
    const presence = new ReaderPresence();
    presence.markProducer("user-a", "shared-id");
    expect(presence.isProducing("user-b", "shared-id")).toBe(false);
  });
```

Update existing tests in that file to pass a `userId` first argument.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/readerPresence.test.ts`
Expected: FAIL — assertions fail, both users share an entry

- [ ] **Step 3: Write minimal implementation**

In `backend/src/readerPresence.ts`, add the same key helper used by `SessionStore` and apply it in all five methods:

```ts
/** Presence is per user as well as per session, for the reason in SessionStore. */
function presenceKey(userId: string, sessionId: string): string {
  return `${userId}:${sessionId}`;
}
```

- [ ] **Step 4: Thread `userId` through the presence route**

In `backend/src/server.ts`, the `/v1/presence` handler and the two `readers.mark*` calls inside `/v1/audio` pass `principal.userId`.

- [ ] **Step 5: Run the tests**

Run: `cd backend && npx vitest run src/readerPresence.test.ts src/server.presence.test.ts && npm run build`
Expected: PASS, clean type check

- [ ] **Step 6: Commit**

```bash
git add backend/src/readerPresence.ts backend/src/readerPresence.test.ts backend/src/server.ts backend/src/server.presence.test.ts
git commit -m "fix(relay): scope reader and producer presence to their owner"
```

---

### Task 10: Pairing endpoints

**Files:**
- Modify: `backend/src/server.ts`
- Test: `backend/src/server.pairing.test.ts` (create)

**Interfaces:**
- Consumes: `issuePairingCode`, `claimPairingCode`, `ClaimResult` (Task 3); `userDir` (Task 8).
- Produces: `POST /v1/pair/code` → `{ code, expiresAt }`; `POST /v1/pair/claim` with body `{ code }` → `{ userId }` on success, `409 { error }` otherwise.

On a successful claim with `fromUserId !== toUserId`, any transcripts the claiming device had accumulated move into the destination user's directory.

- [ ] **Step 1: Write the failing test**

Create `backend/src/server.pairing.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { startServer, CaptionServer } from "./server";
import { IdentityStore } from "./identityStore";
import { openDb } from "./db";
import { TranscriptStore, userDir, listTranscripts } from "./transcriptStore";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";

let server: CaptionServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function start(root: string) {
  const identity = new IdentityStore(openDb(":memory:"));
  const transcripts = new TranscriptStore({ root });
  server = startServer({
    port: 0,
    identity,
    createProvider: () => new FakeTranscriptionProvider(),
    transcripts,
    transcriptsRoot: root,
  });
  const addr = server.address();
  return {
    port: typeof addr === "object" && addr ? addr.port : 0,
    identity,
    transcripts,
  };
}

describe("pairing", () => {
  it("merges the watch into the phone's account", async () => {
    const root = mkdtempSync(join(tmpdir(), "wc-"));
    const { port, identity } = start(root);
    const phone = identity.registerDevice("phone");
    const watch = identity.registerDevice("watch");

    const issued = await fetch(`http://127.0.0.1:${port}/v1/pair/code`, {
      method: "POST",
      headers: { authorization: `Bearer ${phone.token}` },
    });
    const { code } = (await issued.json()) as { code: string };

    const claimed = await fetch(`http://127.0.0.1:${port}/v1/pair/claim`, {
      method: "POST",
      headers: { authorization: `Bearer ${watch.token}` },
      body: JSON.stringify({ code }),
    });
    expect(claimed.status).toBe(200);
    expect((await claimed.json()) as { userId: string }).toEqual({ userId: phone.userId });
    expect(identity.resolve(watch.token)!.userId).toBe(phone.userId);
  });

  it("moves the claiming device's transcripts to the new owner", async () => {
    const root = mkdtempSync(join(tmpdir(), "wc-"));
    const { port, identity, transcripts } = start(root);
    const phone = identity.registerDevice("phone");
    const watch = identity.registerDevice("watch");
    transcripts.append(watch.userId, "s1", "recorded before pairing");
    transcripts.finalize(watch.userId, "s1");

    const issued = await fetch(`http://127.0.0.1:${port}/v1/pair/code`, {
      method: "POST",
      headers: { authorization: `Bearer ${phone.token}` },
    });
    const { code } = (await issued.json()) as { code: string };
    await fetch(`http://127.0.0.1:${port}/v1/pair/claim`, {
      method: "POST",
      headers: { authorization: `Bearer ${watch.token}` },
      body: JSON.stringify({ code }),
    });

    expect(listTranscripts(userDir(root, phone.userId))).toHaveLength(1);
    expect(existsSync(userDir(root, watch.userId))).toBe(false);
  });

  it("rejects an unknown code", async () => {
    const root = mkdtempSync(join(tmpdir(), "wc-"));
    const { port, identity } = start(root);
    const watch = identity.registerDevice("watch");
    const res = await fetch(`http://127.0.0.1:${port}/v1/pair/claim`, {
      method: "POST",
      headers: { authorization: `Bearer ${watch.token}` },
      body: JSON.stringify({ code: "000000" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toEqual({ error: "unknown" });
  });

  it("requires authentication to issue a code", async () => {
    const root = mkdtempSync(join(tmpdir(), "wc-"));
    const { port } = start(root);
    const res = await fetch(`http://127.0.0.1:${port}/v1/pair/code`, { method: "POST" });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/server.pairing.test.ts`
Expected: FAIL — routes return 404

- [ ] **Step 3: Write minimal implementation**

Add to `backend/src/server.ts`, after the `/v1/devices` route. Add `renameSync`, `existsSync`, and `rmSync` from `fs` and `userDir` from `./transcriptStore` to the imports.

```ts
  // The phone issues a code; the watch claims it. Pairing exists because the
  // two apps register independently and would otherwise be two accounts.
  if (req.method === "POST" && url.pathname === "/v1/pair/code") {
    const principal = principalFor(req, url, opts);
    if (!principal) {
      sendJSON(res, 401, { error: "unauthorized" });
      return;
    }
    sendJSON(res, 200, opts.identity.issuePairingCode(principal.userId));
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/pair/claim") {
    const principal = principalFor(req, url, opts);
    if (!principal) {
      sendJSON(res, 401, { error: "unauthorized" });
      return;
    }
    let body: Buffer;
    try {
      body = await readBody(req, MAX_REGISTRATION_BYTES);
    } catch {
      sendJSON(res, 413, { error: "body too large" });
      return;
    }
    let code: unknown;
    try {
      code = (JSON.parse(body.toString("utf8")) as { code?: unknown } | null)?.code;
    } catch {
      sendJSON(res, 400, { error: "invalid json" });
      return;
    }
    if (typeof code !== "string") {
      sendJSON(res, 400, { error: "missing code" });
      return;
    }
    const result = opts.identity.claimPairingCode(code, principal);
    if (!result.ok) {
      sendJSON(res, 409, { error: result.reason });
      return;
    }
    if (result.fromUserId !== result.toUserId && opts.transcriptsRoot) {
      moveTranscripts(opts.transcriptsRoot, result.fromUserId, result.toUserId);
    }
    sendJSON(res, 200, { userId: result.toUserId });
    return;
  }
```

Add the mover near `sendJSON`:

```ts
/**
 * Carry a merged-away user's transcripts to their new owner.
 *
 * Files are moved individually rather than by renaming the directory, because
 * the destination usually already exists. A failure here leaves the transcript
 * where it was rather than losing it — pairing has already succeeded, and a
 * stranded file is recoverable in a way a deleted one is not.
 */
function moveTranscripts(root: string, fromUserId: string, toUserId: string): void {
  const from = userDir(root, fromUserId);
  if (!existsSync(from)) return;
  const to = userDir(root, toUserId);
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    try {
      renameSync(join(from, entry), join(to, entry));
    } catch (err) {
      console.error(`could not move ${entry} during pairing:`, err);
    }
  }
  try {
    rmSync(from, { recursive: true });
  } catch {
    // A directory that would not go is not worth failing the pairing over.
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && npx vitest run src/server.pairing.test.ts && npm run build`
Expected: PASS, clean type check

- [ ] **Step 5: Commit**

```bash
git add backend/src/server.ts backend/src/server.pairing.test.ts
git commit -m "feat(relay): pair a watch to a phone with a six-digit code"
```

---

### Task 11: Per-session provider, and delete relay settings

**Files:**
- Modify: `backend/src/server.ts`
- Delete: `backend/src/settings.ts`, `backend/src/settings.test.ts`, `backend/src/settingsStore.ts`, `backend/src/settingsStore.test.ts`, `backend/src/server.settings.test.ts`
- Test: `backend/src/server.http.test.ts`

**Interfaces:**
- Produces: `POST /v1/audio` accepts `?provider=<name>`, validated against `PROVIDER_NAMES`, read only when the session is created. `StartServerOptions.settingsFile` is removed.

`server.ts:62` reads `settings.get().provider` today. Deleting settings without this would silently remove provider selection.

- [ ] **Step 1: Write the failing test**

Add to `backend/src/server.http.test.ts`:

```ts
  it("uses the provider named on the request", async () => {
    const seen: (string | undefined)[] = [];
    const identity = new IdentityStore(openDb(":memory:"));
    const device = identity.registerDevice("watch");
    server = startServer({
      port: 0,
      identity,
      createProvider: (o) => {
        seen.push(o?.provider);
        return new FakeTranscriptionProvider();
      },
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    await fetch(`http://127.0.0.1:${port}/v1/audio?session=s1&provider=openai`, {
      method: "POST",
      headers: { authorization: `Bearer ${device.token}` },
      body: Buffer.alloc(3200),
    });
    expect(seen).toEqual(["openai"]);
  });

  it("ignores an unknown provider rather than failing the request", async () => {
    const seen: (string | undefined)[] = [];
    const identity = new IdentityStore(openDb(":memory:"));
    const device = identity.registerDevice("watch");
    server = startServer({
      port: 0,
      identity,
      createProvider: (o) => {
        seen.push(o?.provider);
        return new FakeTranscriptionProvider();
      },
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    const res = await fetch(`http://127.0.0.1:${port}/v1/audio?session=s1&provider=toaster`, {
      method: "POST",
      headers: { authorization: `Bearer ${device.token}` },
      body: Buffer.alloc(3200),
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual([undefined]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/server.http.test.ts`
Expected: FAIL — `seen` is `[undefined]` in the first case

- [ ] **Step 3: Write minimal implementation**

In `backend/src/server.ts`:

Delete the `SettingsStore` import, the `const settings = new SettingsStore(...)` line, the `settingsFile` option, the `MAX_SETTINGS_BYTES` constant, the whole `/v1/settings` route block, and the `settings` parameter from `handleRequest`.

Simplify the `SessionStore` construction, since the provider is no longer read from stored settings:

```ts
  const store = new SessionStore({
    createProvider: opts.createProvider,
    transcripts: opts.transcripts,
  });
```

In the `/v1/audio` branch, read the provider alongside `ephemeral` and `resume` and pass it into `feed`:

```ts
      // Read at creation and only at creation: swapping engines partway
      // through a conversation would leave one transcript spoken in two
      // voices. A later post carrying a different name is ignored, the same
      // way `ephemeral` and `resume` are.
      const requested = url.searchParams.get("provider");
      const provider = PROVIDER_NAMES.find((name) => name === requested);
      const providerOpts: ProviderOptions | undefined = provider ? { provider } : undefined;
```

then:

```ts
      store.feed(principal.userId, session, body, ephemeral, providerOpts);
```

- [ ] **Step 4: Delete the settings modules**

```bash
cd backend && rm src/settings.ts src/settings.test.ts src/settingsStore.ts src/settingsStore.test.ts src/server.settings.test.ts
```

- [ ] **Step 5: Run the full suite**

Run: `cd backend && npm test && npm run build`
Expected: PASS, clean type check

- [ ] **Step 6: Commit**

```bash
git add -A backend/src
git commit -m "feat(relay): pick the provider per session and drop relay settings"
```

---

### Task 12: Boot migration, wiring, and the runtime bump

**Files:**
- Create: `backend/src/tenantMigration.ts`
- Test: `backend/src/tenantMigration.test.ts`
- Modify: `backend/src/index.ts`, `backend/src/config.ts`, `backend/Dockerfile`, `backend/fly.toml`

**Interfaces:**
- Consumes: `IdentityStore` (Task 2), `userDir` (Task 8).
- Produces: `function migrateFlatTranscripts(root: string, identity: IdentityStore): { userId: string; token: string; moved: number } | null` — returns `null` when there is nothing to migrate.

- [ ] **Step 1: Write the failing test**

Create `backend/src/tenantMigration.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { migrateFlatTranscripts } from "./tenantMigration";
import { IdentityStore } from "./identityStore";
import { openDb } from "./db";
import { userDir } from "./transcriptStore";

function identityStore(): IdentityStore {
  return new IdentityStore(openDb(":memory:"));
}

describe("migrateFlatTranscripts", () => {
  it("moves flat transcripts under a new user", () => {
    const root = mkdtempSync(join(tmpdir(), "wc-"));
    writeFileSync(join(root, "2026-01-01T00-00-00Z_s1.jsonl"), '{"at":"x","text":"hi"}\n');
    writeFileSync(join(root, "2026-01-01T00-00-00Z_s1.summary.md"), "summary");

    const result = migrateFlatTranscripts(root, identityStore())!;
    expect(result.moved).toBe(2);
    expect(readdirSync(userDir(root, result.userId)).sort()).toEqual([
      "2026-01-01T00-00-00Z_s1.jsonl",
      "2026-01-01T00-00-00Z_s1.summary.md",
    ]);
  });

  it("issues a usable token for the adopted user", () => {
    const root = mkdtempSync(join(tmpdir(), "wc-"));
    writeFileSync(join(root, "2026-01-01T00-00-00Z_s1.jsonl"), '{"at":"x","text":"hi"}\n');
    const identity = identityStore();
    const result = migrateFlatTranscripts(root, identity)!;
    expect(identity.resolve(result.token)!.userId).toBe(result.userId);
  });

  it("drops the old settings file", () => {
    const root = mkdtempSync(join(tmpdir(), "wc-"));
    writeFileSync(join(root, "2026-01-01T00-00-00Z_s1.jsonl"), '{"at":"x","text":"hi"}\n');
    writeFileSync(join(root, "settings.json"), "{}");
    migrateFlatTranscripts(root, identityStore());
    expect(existsSync(join(root, "settings.json"))).toBe(false);
  });

  it("no-ops when there is nothing at the flat root", () => {
    const root = mkdtempSync(join(tmpdir(), "wc-"));
    expect(migrateFlatTranscripts(root, identityStore())).toBeNull();
  });

  it("is idempotent", () => {
    const root = mkdtempSync(join(tmpdir(), "wc-"));
    writeFileSync(join(root, "2026-01-01T00-00-00Z_s1.jsonl"), '{"at":"x","text":"hi"}\n');
    const identity = identityStore();
    migrateFlatTranscripts(root, identity);
    expect(migrateFlatTranscripts(root, identity)).toBeNull();
  });

  it("leaves an already-migrated user's directory alone", () => {
    const root = mkdtempSync(join(tmpdir(), "wc-"));
    const identity = identityStore();
    const existing = identity.registerDevice("watch");
    const existingDir = userDir(root, existing.userId);
    mkdirSync(existingDir, { recursive: true });
    writeFileSync(join(existingDir, "2026-02-02T00-00-00Z_s2.jsonl"), '{"at":"y","text":"kept"}\n');
    writeFileSync(join(root, "2026-01-01T00-00-00Z_s1.jsonl"), '{"at":"x","text":"hi"}\n');

    const result = migrateFlatTranscripts(root, identity)!;

    // Only the loose file moved, and it went to a new user rather than
    // being swept into whoever already had a directory here.
    expect(result.moved).toBe(1);
    expect(result.userId).not.toBe(existing.userId);
    expect(readdirSync(existingDir)).toEqual(["2026-02-02T00-00-00Z_s2.jsonl"]);
    expect(readdirSync(userDir(root, result.userId))).toEqual([
      "2026-01-01T00-00-00Z_s1.jsonl",
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/tenantMigration.test.ts`
Expected: FAIL — `Cannot find module './tenantMigration'`

- [ ] **Step 3: Write minimal implementation**

Create `backend/src/tenantMigration.ts`:

```ts
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "fs";
import { join } from "path";
import { IdentityStore } from "./identityStore";
import { userDir } from "./transcriptStore";

export interface MigrationResult {
  userId: string;
  /** Printed once at boot so the operator can adopt their existing installs. */
  token: string;
  moved: number;
}

/**
 * Move transcripts written before the relay was multi-tenant under a user of
 * their own.
 *
 * Runs at boot and no-ops once the flat root is empty, so it is safe on every
 * start. The token is returned rather than logged here, leaving the decision
 * about what reaches the logs to the caller.
 */
export function migrateFlatTranscripts(
  root: string,
  identity: IdentityStore,
): MigrationResult | null {
  if (!existsSync(root)) return null;

  const loose = readdirSync(root).filter((entry) => {
    if (entry === "settings.json") return false;
    return statSync(join(root, entry)).isFile();
  });
  const settingsFile = join(root, "settings.json");
  const hasSettings = existsSync(settingsFile);

  if (loose.length === 0) {
    // Settings alone are still worth clearing, but they do not justify
    // minting a user nobody owns.
    if (hasSettings) rmSync(settingsFile, { force: true });
    return null;
  }

  const adopted = identity.registerDevice("mac");
  const dir = userDir(root, adopted.userId);
  mkdirSync(dir, { recursive: true });

  let moved = 0;
  for (const entry of loose) {
    try {
      renameSync(join(root, entry), join(dir, entry));
      moved += 1;
    } catch (err) {
      console.error(`could not migrate ${entry}:`, err);
    }
  }

  // Settings now live on the phone and are delivered over WatchConnectivity.
  if (hasSettings) rmSync(settingsFile, { force: true });

  return { userId: adopted.userId, token: adopted.token, moved };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/tenantMigration.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Update config**

In `backend/src/config.ts`: remove `authToken` from `Config` and the `if (!authToken) throw` guard; add:

```ts
  /** Operator-only token for /v1/usage. */
  adminToken?: string;
  /** Where the identity database lives (beside the transcripts, on the volume). */
  dbPath: string;
```

and in the returned object:

```ts
    adminToken: env.ADMIN_TOKEN || undefined,
    dbPath: env.DB_PATH || join(transcriptsDir, "identity.db"),
```

Import `join` from `path` there. Update `config.test.ts` for the removed `AUTH_TOKEN` requirement.

- [ ] **Step 6: Wire it up in `index.ts`**

Replace the relevant parts of `backend/src/index.ts`:

```ts
const db = openDb(config.dbPath);
const identity = new IdentityStore(db);

const migrated = migrateFlatTranscripts(config.transcriptsDir, identity);
if (migrated) {
  console.log(
    `Migrated ${migrated.moved} file(s) to user ${migrated.userId}. ` +
      `Adopt existing installs with this token (shown once): ${migrated.token}`,
  );
}

const transcripts = new TranscriptStore({
  root: config.transcriptsDir,
  onFinalize: createFinalizer({
    root: config.transcriptsDir,
    summarize,
    export: exportTranscript,
    update: config.notion ? createNotionUpdater(config.notion) : undefined,
  }),
});
```

and in `startServer`, replace `authToken: config.authToken` with `identity`, rename `transcriptsDir` to `transcriptsRoot`, add `adminToken: config.adminToken`, and delete the `settingsFile` option and its comment.

The two backfill calls in `runBackfills` iterate the per-user directories. Replace their `dir: config.transcriptsDir` with a loop:

```ts
function userDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((entry) => statSync(join(root, entry)).isDirectory())
    .map((entry) => join(root, entry));
}
```

and call each backfill once per directory, summing the results.

- [ ] **Step 7: Bump the runtime**

In `backend/Dockerfile`, change the base image and record why:

```dockerfile
# Node 24: the relay's identity database uses the built-in `node:sqlite`,
# which is unflagged from Node 23.4 onward. Staying on 20 would mean taking
# on `better-sqlite3` and the build toolchain a native module needs.
FROM node:24-slim
```

- [ ] **Step 8: Run the full suite**

Run: `cd backend && npm test && npm run build`
Expected: PASS, clean type check

- [ ] **Step 9: Verify `node:sqlite` on the pinned image**

Run: `docker run --rm node:24-slim node -e "const {DatabaseSync}=require('node:sqlite'); new DatabaseSync(':memory:'); console.log('ok')"`
Expected: `ok`, with no experimental flag. If this fails, move the base image to `node:26-slim` and note it in the commit.

- [ ] **Step 10: Commit**

```bash
git add backend/src backend/Dockerfile backend/fly.toml
git commit -m "feat(relay): adopt existing transcripts into a user at boot"
```

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| 3, Schema (users, devices, pairing_codes) | 1 |
| 3, Registration + rate limit | 2, 5 |
| 3, Pairing | 3, 10 |
| 4, `resolveToken` / `Principal` | 4, 6 |
| 4, Bearer token transport | 4, 6 |
| 5, `sessionStore.ts` | 7 |
| 5, `transcriptStore.ts` | 8 |
| 5, `readerPresence.ts` | 9 |
| 5, `/v1/usage` admin gate | 6 |
| 5, settings deleted | 11 |
| 5, `/app` viewer bearer header | 6 |
| 5, Provider after settings leave | 11 |
| 8, Migration | 12 |
| 9, Testing | throughout; cross-tenant suite in 7, 8 |

`export_destinations` (spec section 3's fourth table) and spec section 6 are deliberately absent — they belong to Plan 2, along with the migration's step 4, which folds the existing `NOTION_TOKEN` env vars into a destination row. Task 12's migration therefore leaves those env vars in place and untouched; Plan 2 removes them.

**Known ordering wrinkle**

Task 4 leaves `npm run build` failing, because `server.ts` still imports the deleted `verifyToken` until Task 6. This is called out in Task 4 Step 5 and is intentional — the alternative is one enormous task spanning auth and every route. Task 7 has a smaller version of the same: transcript calls take a `userId` that `TranscriptStore` does not accept until Task 8. Do not attempt to fix either early.

**Deferred from this plan**

- Twilio webhook signature validation, per the spec.
- Litestream for the SQLite volume. Single-machine SQLite on a Fly volume is the spec's accepted position; durability is a follow-up.
