# Per-User Export Destinations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each user send their own finished transcripts to their own Notion workspace or their own email address, configured from the `/app` web viewer, replacing the single operator-wide `NOTION_TOKEN`.

**Architecture:** A new `export_destinations` table holds one row per user per destination kind, with secrets encrypted at rest under `ENCRYPTION_KEY`. Notion authorization runs entirely in the browser — the relay hosts both the start and callback endpoints, so the `client_secret` never leaves the server. The existing Notion exporter modules are unchanged; what changes is that they are constructed per user at export time instead of once at boot.

**Tech Stack:** Node 24+ (ESM), TypeScript, `node:sqlite`, `node:crypto` (AES-256-GCM), vitest. Email via the Resend REST API over plain `fetch`. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-08-14-multi-tenancy-and-exports-design.md` — section 6, **as amended 2026-08-15**. Read the amendment block at the top of section 6 first; it moves configuration off the phone and into `/app`, and the rest of section 6 predates it.

## Global Constraints

- **No new npm dependencies.** Encryption from `node:crypto`; email over `fetch` against Resend's REST API.
- **`node:sqlite` returns null-prototype row objects.** Spread rows into plain objects (`{ ...row }`) at the store boundary before returning them.
- **ESM, no file extensions in relative imports** — e.g. `import { openDb } from "./db"`.
- **Tests are colocated** as `src/<module>.test.ts`, run with `npm test` (`vitest run`).
- **`db.ts` must not import `node:sqlite` statically** — vitest 2.1.9 cannot resolve it. Follow the existing `import type` + `process.getBuiltinModule("node:sqlite")` pattern already in that file.
- **Every store method that takes a `userId` takes it first**, matching `SessionStore`, `TranscriptStore`, and `ReaderPresence`.
- **Secrets are never logged and never returned to a client.** `/app` may see whether a destination is connected and its non-secret fields; it must never see a token.
- Type check with `npm run build` (`tsc --noEmit`) before every commit.
- **Every new test must be verified red before green.** The preceding plan repeatedly shipped tests that could not fail; each was caught in review. Record the evidence.

## Scope

Spec section 6's two **relay-side** destinations only. Files/iCloud and the share sheet are phone-side and belong to Plan 3, which is blocked on the paid Apple Developer Program membership.

## What already exists — do not rebuild it

Plan 1 shipped the foundation this builds on:

- `db.ts` — `openDb(path)`, `type Db`, migration block with `CREATE TABLE IF NOT EXISTS`.
- `identityStore.ts` — `IdentityStore`, `Principal { userId, deviceId }`.
- `auth.ts` — `bearerToken(header)`, `resolveToken(identity, token)`.
- `server.ts` — `principalFor(req, url, opts)`, `RegistrationLimiter` (accepts `limit`/`windowMs`), `readBody(req, maxBytes)`, `sendJSON(res, status, body)`.
- `transcriptStore.ts` — `userDir(root, userId)`, `FinalizedTranscript` **carrying `userId`**, `TRANSCRIPT_SUFFIXES`.
- `notionExporter.ts` — `createNotionExporter(opts: NotionExporterOptions)`, `createNotionSummaryPatcher(opts)`, `createRequest(opts)`, where `NotionExporterOptions` is `{ token: string; databaseId: string }`.
- `notionUpdater.ts` — `createNotionUpdater(opts: NotionExporterOptions)`.
- `finalizer.ts` — `createFinalizer(opts)`, `FinalizerOptions { root, summarize?, export?, update? }`, `exportOnce(...)`, `isSubstantial(t)`.
- `notionBackfill.ts` / `summaryBackfill.ts` — both take `{ dir, userId, ... }` and already thread `userId` into `rebuildFinalized`. That was added specifically as groundwork for this plan.
- `index.ts` — `userDirs(root)` returning `{ dir, userId }[]`.

The Notion modules are correct and stay correct. The only change they need is being constructed with a per-user token rather than a global one.

## File Structure

**Created:**
- `src/secretBox.ts` — AES-256-GCM seal/open. Nothing else.
- `src/secretBox.test.ts`
- `src/exportDestinations.ts` — the store: per-user rows, encryption at the boundary.
- `src/exportDestinations.test.ts`
- `src/notionOAuth.ts` — authorization URL, state minting/verification, code exchange.
- `src/notionOAuth.test.ts`
- `src/emailSender.ts` — Resend REST call behind an injectable interface.
- `src/emailSender.test.ts`
- `src/emailVerification.ts` — verification token lifecycle.
- `src/emailVerification.test.ts`
- `src/exportsPage.ts` — the `/app/exports` HTML.
- `src/server.exports.test.ts` — route-level tests including cross-tenant isolation.

**Modified:**
- `src/db.ts` — `export_destinations` and `oauth_states` tables.
- `src/config.ts` — Notion OAuth client credentials, `ENCRYPTION_KEY`, Resend key, sender address, public base URL.
- `src/finalizer.ts` — `export`/`update` become a per-user resolver.
- `src/notionBackfill.ts`, `src/summaryBackfill.ts` — accept a resolved exporter per user.
- `src/index.ts` — construct the store, pass the resolver, migrate the legacy env Notion config.
- `src/server.ts` — the export routes.
- `src/viewerPage.ts` — a link to `/app/exports`.
- `backend/README.md`, `backend/DEPLOY.md` — the new env vars and the Notion integration setup.

---

### Task 1: Encrypted secret storage

**Files:**
- Create: `backend/src/secretBox.ts`
- Test: `backend/src/secretBox.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `function seal(plaintext: string, key: Buffer): string`
  - `function open(sealed: string, key: Buffer): string` — throws on tamper or wrong key
  - `function keyFromEnv(value: string | undefined): Buffer` — throws a clear error unless `value` decodes to exactly 32 bytes

Sealed format is `v1.<iv-b64url>.<tag-b64url>.<ciphertext-b64url>`. The version prefix exists so a future algorithm change is detectable rather than silently misparsed.

- [ ] **Step 1: Write the failing test**

Create `backend/src/secretBox.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/secretBox.test.ts`
Expected: FAIL — `Cannot find module './secretBox'`

- [ ] **Step 3: Write minimal implementation**

Create `backend/src/secretBox.ts`:

```ts
import { randomBytes, createCipheriv, createDecipheriv } from "crypto";

/**
 * Authenticated encryption for the secrets in `export_destinations`.
 *
 * GCM rather than plain CBC because a tampered ciphertext must fail loudly:
 * these values are used to authenticate against someone else's account, and a
 * silently corrupted token would surface as a confusing 401 from Notion rather
 * than as the storage fault it is.
 */
const VERSION = "v1";
const IV_BYTES = 12;

export function seal(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function open(sealed: string, key: Buffer): string {
  const parts = sealed.split(".");
  if (parts.length !== 4) throw new Error("sealed value is malformed");
  const [version, iv, tag, ciphertext] = parts as [string, string, string, string];
  if (version !== VERSION) throw new Error(`unknown sealed value version: ${version}`);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * Read the master key. Fails loudly rather than defaulting: a relay that
 * silently generated a key per boot would encrypt tokens it could never read
 * again, and the failure would look like every user spontaneously losing
 * their Notion connection.
 */
export function keyFromEnv(value: string | undefined): Buffer {
  if (!value) throw new Error("ENCRYPTION_KEY is required to store export secrets");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new Error(`ENCRYPTION_KEY must decode to 32 bytes, got ${key.length}`);
  }
  return key;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx vitest run src/secretBox.test.ts`
Expected: PASS, 10 tests

- [ ] **Step 5: Verify the type check is clean**

Run: `cd backend && npm run build`
Expected: no output, exit 0

- [ ] **Step 6: Commit**

```bash
git add backend/src/secretBox.ts backend/src/secretBox.test.ts
git commit -m "feat(relay): authenticated encryption for stored export secrets"
```

---

### Task 2: The `export_destinations` store

**Files:**
- Modify: `backend/src/db.ts`
- Create: `backend/src/exportDestinations.ts`
- Test: `backend/src/exportDestinations.test.ts`

**Interfaces:**
- Consumes: `Db`/`openDb` (Task 1 of the previous plan), `seal`/`open` (Task 1).
- Produces:
  - `type DestinationKind = "notion" | "email"`
  - `interface NotionConfigRow { databaseId: string; workspaceName?: string }`
  - `interface EmailConfigRow { address: string; verifiedAt?: string }`
  - `class ExportDestinationStore` with `constructor(db: Db, key: Buffer, opts?: { now?: () => number })`
    - `putNotion(userId: string, secretToken: string, config: NotionConfigRow): void`
    - `getNotion(userId: string): { token: string; config: NotionConfigRow } | null`
    - `putEmail(userId: string, config: EmailConfigRow): void`
    - `getEmail(userId: string): EmailConfigRow | null`
    - `list(userId: string): { kind: DestinationKind; connected: boolean; detail: string }[]` — **never includes secrets**; safe to serialise to a client
    - `remove(userId: string, kind: DestinationKind): boolean`

- [ ] **Step 1: Add the table to the migration**

In `backend/src/db.ts`, inside the existing `migrate()` template literal, after the `pairing_codes` indexes:

```sql
    CREATE TABLE IF NOT EXISTS export_destinations (
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL CHECK (kind IN ('notion','email')),
      config      TEXT NOT NULL,
      secret      TEXT,
      created_at  TEXT NOT NULL,
      PRIMARY KEY (user_id, kind)
    );
```

`secret` is nullable because the email destination has none — its address is not confidential in the way a bearer token is, and storing it in clear text keeps it debuggable, which the spec calls for.

- [ ] **Step 2: Write the failing test**

Create `backend/src/exportDestinations.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { randomBytes } from "crypto";
import { openDb } from "./db";
import { IdentityStore } from "./identityStore";
import { ExportDestinationStore } from "./exportDestinations";

const key = randomBytes(32);

function fixture() {
  const db = openDb(":memory:");
  const identity = new IdentityStore(db);
  const alice = identity.registerDevice("phone").userId;
  const mallory = identity.registerDevice("phone").userId;
  return { db, store: new ExportDestinationStore(db, key), alice, mallory };
}

describe("ExportDestinationStore notion", () => {
  it("round-trips a token and config", () => {
    const { store, alice } = fixture();
    store.putNotion(alice, "ntn_secret", { databaseId: "db1", workspaceName: "Notes" });
    expect(store.getNotion(alice)).toEqual({
      token: "ntn_secret",
      config: { databaseId: "db1", workspaceName: "Notes" },
    });
  });

  it("never stores the token in clear text", () => {
    const { db, store, alice } = fixture();
    store.putNotion(alice, "ntn_secret", { databaseId: "db1" });
    const row = db.prepare("SELECT secret, config FROM export_destinations").get() as {
      secret: string;
      config: string;
    };
    expect(row.secret).not.toContain("ntn_secret");
    expect(row.config).not.toContain("ntn_secret");
  });

  it("returns null for a user with no destination", () => {
    const { store, mallory } = fixture();
    expect(store.getNotion(mallory)).toBeNull();
  });

  it("does not leak one user's destination to another", () => {
    const { store, alice, mallory } = fixture();
    store.putNotion(alice, "ntn_secret", { databaseId: "db1" });
    expect(store.getNotion(mallory)).toBeNull();
    expect(store.list(mallory)).toEqual([]);
  });

  it("replaces an existing connection rather than duplicating it", () => {
    const { db, store, alice } = fixture();
    store.putNotion(alice, "first", { databaseId: "db1" });
    store.putNotion(alice, "second", { databaseId: "db2" });
    expect(store.getNotion(alice)!.token).toBe("second");
    const count = db
      .prepare("SELECT count(*) AS n FROM export_destinations WHERE user_id = ?")
      .get(alice) as { n: number };
    expect(count.n).toBe(1);
  });
});

describe("ExportDestinationStore email", () => {
  it("round-trips an address", () => {
    const { store, alice } = fixture();
    store.putEmail(alice, { address: "a@example.com" });
    expect(store.getEmail(alice)).toEqual({ address: "a@example.com" });
  });

  it("carries the verification timestamp", () => {
    const { store, alice } = fixture();
    store.putEmail(alice, { address: "a@example.com", verifiedAt: "2026-08-15T00:00:00.000Z" });
    expect(store.getEmail(alice)!.verifiedAt).toBe("2026-08-15T00:00:00.000Z");
  });
});

describe("ExportDestinationStore list", () => {
  it("reports connection state without secrets", () => {
    const { store, alice } = fixture();
    store.putNotion(alice, "ntn_secret", { databaseId: "db1", workspaceName: "Notes" });
    store.putEmail(alice, { address: "a@example.com" });
    const listed = store.list(alice);
    expect(JSON.stringify(listed)).not.toContain("ntn_secret");
    expect(listed.find((d) => d.kind === "notion")).toEqual({
      kind: "notion",
      connected: true,
      detail: "Notes",
    });
    expect(listed.find((d) => d.kind === "email")).toEqual({
      kind: "email",
      connected: false,
      detail: "a@example.com",
    });
  });

  it("reports an email destination as connected once verified", () => {
    const { store, alice } = fixture();
    store.putEmail(alice, { address: "a@example.com", verifiedAt: "2026-08-15T00:00:00.000Z" });
    expect(store.list(alice)[0]!.connected).toBe(true);
  });
});

describe("ExportDestinationStore remove", () => {
  it("removes only the named kind for the named user", () => {
    const { store, alice, mallory } = fixture();
    store.putNotion(alice, "ntn_secret", { databaseId: "db1" });
    store.putEmail(alice, { address: "a@example.com" });
    store.putNotion(mallory, "other", { databaseId: "db2" });

    expect(store.remove(alice, "notion")).toBe(true);
    expect(store.getNotion(alice)).toBeNull();
    expect(store.getEmail(alice)).not.toBeNull();
    expect(store.getNotion(mallory)).not.toBeNull();
  });

  it("returns false when there was nothing to remove", () => {
    const { store, alice } = fixture();
    expect(store.remove(alice, "notion")).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && npx vitest run src/exportDestinations.test.ts`
Expected: FAIL — `Cannot find module './exportDestinations'`

- [ ] **Step 4: Write minimal implementation**

Create `backend/src/exportDestinations.ts`:

```ts
import { Db } from "./db";
import { seal, open } from "./secretBox";

export type DestinationKind = "notion" | "email";

export interface NotionConfigRow {
  databaseId: string;
  /** Shown in `/app` so a user can tell which workspace they connected. */
  workspaceName?: string;
}

export interface EmailConfigRow {
  address: string;
  /** Unset until the confirmation link is followed. */
  verifiedAt?: string;
}

export interface ListedDestination {
  kind: DestinationKind;
  /** Whether this destination will actually receive transcripts. */
  connected: boolean;
  /** A short human label — workspace name or address. Never a secret. */
  detail: string;
}

/**
 * Where each user's finished transcripts are sent.
 *
 * Secrets are sealed on the way in and opened on the way out, so the only
 * plaintext copy of a Notion token lives in memory for the duration of one
 * export. `list()` is the only method a client's response is built from, and
 * it is deliberately incapable of returning a secret.
 */
export class ExportDestinationStore {
  private readonly now: () => number;

  constructor(
    private readonly db: Db,
    private readonly key: Buffer,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
  }

  putNotion(userId: string, secretToken: string, config: NotionConfigRow): void {
    this.put(userId, "notion", JSON.stringify(config), seal(secretToken, this.key));
  }

  getNotion(userId: string): { token: string; config: NotionConfigRow } | null {
    const row = this.row(userId, "notion");
    if (!row?.secret) return null;
    return {
      token: open(row.secret, this.key),
      config: JSON.parse(row.config) as NotionConfigRow,
    };
  }

  putEmail(userId: string, config: EmailConfigRow): void {
    this.put(userId, "email", JSON.stringify(config), null);
  }

  getEmail(userId: string): EmailConfigRow | null {
    const row = this.row(userId, "email");
    if (!row) return null;
    return JSON.parse(row.config) as EmailConfigRow;
  }

  list(userId: string): ListedDestination[] {
    const notion = this.row(userId, "notion");
    const email = this.getEmail(userId);
    const out: ListedDestination[] = [];
    if (notion) {
      const config = JSON.parse(notion.config) as NotionConfigRow;
      out.push({
        kind: "notion",
        connected: Boolean(notion.secret),
        detail: config.workspaceName ?? config.databaseId,
      });
    }
    if (email) {
      out.push({
        kind: "email",
        connected: Boolean(email.verifiedAt),
        detail: email.address,
      });
    }
    return out;
  }

  remove(userId: string, kind: DestinationKind): boolean {
    const before = this.row(userId, kind);
    if (!before) return false;
    this.db
      .prepare("DELETE FROM export_destinations WHERE user_id = ? AND kind = ?")
      .run(userId, kind);
    return true;
  }

  private put(userId: string, kind: DestinationKind, config: string, secret: string | null): void {
    this.db
      .prepare(
        `INSERT INTO export_destinations (user_id, kind, config, secret, created_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(user_id, kind) DO UPDATE SET config = excluded.config, secret = excluded.secret`,
      )
      .run(userId, kind, config, secret, new Date(this.now()).toISOString());
  }

  private row(userId: string, kind: DestinationKind): { config: string; secret: string | null } | null {
    const row = this.db
      .prepare("SELECT config, secret FROM export_destinations WHERE user_id = ? AND kind = ?")
      .get(userId, kind) as { config: string; secret: string | null } | undefined;
    return row ? { ...row } : null;
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && npx vitest run src/exportDestinations.test.ts src/db.test.ts`
Expected: PASS

- [ ] **Step 6: Verify the type check is clean**

Run: `cd backend && npm run build`
Expected: no output, exit 0

- [ ] **Step 7: Commit**

```bash
git add backend/src/db.ts backend/src/exportDestinations.ts backend/src/exportDestinations.test.ts
git commit -m "feat(relay): per-user export destinations with sealed secrets"
```

---

### Task 3: Notion OAuth — state and code exchange

**Files:**
- Modify: `backend/src/db.ts`
- Create: `backend/src/notionOAuth.ts`
- Test: `backend/src/notionOAuth.test.ts`

**Interfaces:**
- Consumes: `Db`.
- Produces:
  - `interface NotionOAuthConfig { clientId: string; clientSecret: string; redirectUri: string }`
  - `class OAuthStateStore` with `constructor(db: Db, opts?: { now?: () => number })`, `mint(userId: string): string`, `consume(state: string): string | null` (returns the `userId`, single-use), `OAUTH_STATE_TTL_MS`
  - `function authorizeUrl(config: NotionOAuthConfig, state: string): string`
  - `type ExchangeCode = (code: string) => Promise<{ accessToken: string; databaseId?: string; workspaceName?: string }>`
  - `function createCodeExchange(config: NotionOAuthConfig, fetchImpl?: typeof fetch): ExchangeCode`

The `state` value is a CSRF defence, not ceremony. Without it an attacker hands a victim a callback URL carrying the **attacker's** authorization code, and the victim's transcripts start flowing into the attacker's Notion workspace. It must be single-use, expiring, and bound to the user who began the flow.

- [ ] **Step 1: Add the table to the migration**

In `backend/src/db.ts`'s `migrate()`:

```sql
    CREATE TABLE IF NOT EXISTS oauth_states (
      state       TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS oauth_states_expires ON oauth_states(expires_at);
```

- [ ] **Step 2: Write the failing test**

Create `backend/src/notionOAuth.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { openDb } from "./db";
import { IdentityStore } from "./identityStore";
import {
  OAuthStateStore,
  authorizeUrl,
  createCodeExchange,
  OAUTH_STATE_TTL_MS,
} from "./notionOAuth";

const config = {
  clientId: "client-1",
  clientSecret: "shhh",
  redirectUri: "https://relay.example/v1/exports/notion/callback",
};

function fixture(now?: () => number) {
  const db = openDb(":memory:");
  const identity = new IdentityStore(db);
  const alice = identity.registerDevice("phone").userId;
  return { store: new OAuthStateStore(db, now ? { now } : {}), alice };
}

describe("OAuthStateStore", () => {
  it("round-trips a state to its user", () => {
    const { store, alice } = fixture();
    expect(store.consume(store.mint(alice))).toBe(alice);
  });

  it("is single use", () => {
    const { store, alice } = fixture();
    const state = store.mint(alice);
    expect(store.consume(state)).toBe(alice);
    expect(store.consume(state)).toBeNull();
  });

  it("rejects an unknown state", () => {
    const { store } = fixture();
    expect(store.consume("never-minted")).toBeNull();
  });

  it("rejects an expired state", () => {
    let clock = 1_000_000;
    const { store, alice } = fixture(() => clock);
    const state = store.mint(alice);
    clock += OAUTH_STATE_TTL_MS + 1;
    expect(store.consume(state)).toBeNull();
  });

  it("mints unguessable values", () => {
    const { store, alice } = fixture();
    const state = store.mint(alice);
    expect(state.length).toBeGreaterThan(20);
    expect(state).not.toContain(alice);
  });
});

describe("authorizeUrl", () => {
  it("carries the client id, redirect uri and state", () => {
    const url = new URL(authorizeUrl(config, "state-1"));
    expect(url.origin + url.pathname).toBe("https://api.notion.com/v1/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("response_type")).toBe("code");
  });

  it("never carries the client secret", () => {
    expect(authorizeUrl(config, "state-1")).not.toContain("shhh");
  });
});

describe("createCodeExchange", () => {
  it("posts the code with basic auth and returns the token", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen = { url: String(url), init };
      return {
        ok: true,
        json: async () => ({
          access_token: "ntn_granted",
          workspace_name: "Alice's Notes",
          duplicated_template_id: "db-xyz",
        }),
      };
    }) as unknown as typeof fetch;

    const result = await createCodeExchange(config, fakeFetch)("code-1");

    expect(result.accessToken).toBe("ntn_granted");
    expect(result.workspaceName).toBe("Alice's Notes");
    expect(seen!.url).toBe("https://api.notion.com/v1/oauth/token");
    const expected = Buffer.from("client-1:shhh").toString("base64");
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe(`Basic ${expected}`);
    expect(JSON.parse(String(seen!.init.body))).toEqual({
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: config.redirectUri,
    });
  });

  it("throws when Notion rejects the code", async () => {
    const fakeFetch = (async () => ({
      ok: false,
      status: 400,
      text: async () => "invalid_grant",
    })) as unknown as typeof fetch;
    await expect(createCodeExchange(config, fakeFetch)("bad")).rejects.toThrow(/400/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && npx vitest run src/notionOAuth.test.ts`
Expected: FAIL — `Cannot find module './notionOAuth'`

- [ ] **Step 4: Write minimal implementation**

Create `backend/src/notionOAuth.ts`:

```ts
import { randomBytes } from "crypto";
import { Db } from "./db";

export interface NotionOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Must match the URI registered with the Notion integration exactly. */
  redirectUri: string;
}

/** How long a user has to finish the Notion consent screen. */
export const OAUTH_STATE_TTL_MS = 10 * 60_000;

/**
 * The `state` values handed to Notion and expected back.
 *
 * This is the CSRF defence for the whole flow, not a formality. Without it an
 * attacker can hand a victim a callback URL carrying the attacker's own
 * authorization code; the relay would bind the attacker's Notion workspace to
 * the victim's account and every transcript the victim records afterwards
 * would be delivered to the attacker.
 */
export class OAuthStateStore {
  private readonly now: () => number;

  constructor(
    private readonly db: Db,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
  }

  mint(userId: string): string {
    this.db
      .prepare("DELETE FROM oauth_states WHERE expires_at <= ?")
      .run(new Date(this.now()).toISOString());
    const state = randomBytes(32).toString("base64url");
    this.db
      .prepare("INSERT INTO oauth_states (state, user_id, expires_at) VALUES (?,?,?)")
      .run(state, userId, new Date(this.now() + OAUTH_STATE_TTL_MS).toISOString());
    return state;
  }

  /** The user who began this flow, or null. Consumes the state either way. */
  consume(state: string): string | null {
    const row = this.db
      .prepare("SELECT user_id, expires_at FROM oauth_states WHERE state = ?")
      .get(state) as { user_id: string; expires_at: string } | undefined;
    if (!row) return null;
    this.db.prepare("DELETE FROM oauth_states WHERE state = ?").run(state);
    if (Date.parse(row.expires_at) <= this.now()) return null;
    return row.user_id;
  }
}

export function authorizeUrl(config: NotionOAuthConfig, state: string): string {
  const url = new URL("https://api.notion.com/v1/oauth/authorize");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("owner", "user");
  url.searchParams.set("state", state);
  return url.toString();
}

export interface ExchangeResult {
  accessToken: string;
  databaseId?: string;
  workspaceName?: string;
}

export type ExchangeCode = (code: string) => Promise<ExchangeResult>;

/**
 * Trade an authorization code for an access token.
 *
 * The client secret is sent with HTTP Basic auth and never leaves the server,
 * which is the whole reason this exchange happens here rather than in a client.
 */
export function createCodeExchange(
  config: NotionOAuthConfig,
  fetchImpl: typeof fetch = fetch,
): ExchangeCode {
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  return async (code) => {
    const res = await fetchImpl("https://api.notion.com/v1/oauth/token", {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: config.redirectUri,
      }),
    });
    if (!res.ok) {
      throw new Error(`notion token exchange failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as {
      access_token: string;
      workspace_name?: string;
      duplicated_template_id?: string;
    };
    return {
      accessToken: body.access_token,
      ...(body.duplicated_template_id ? { databaseId: body.duplicated_template_id } : {}),
      ...(body.workspace_name ? { workspaceName: body.workspace_name } : {}),
    };
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && npx vitest run src/notionOAuth.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 6: Verify the type check is clean**

Run: `cd backend && npm run build`
Expected: no output, exit 0

- [ ] **Step 7: Commit**

```bash
git add backend/src/db.ts backend/src/notionOAuth.ts backend/src/notionOAuth.test.ts
git commit -m "feat(relay): Notion OAuth state and code exchange"
```

---

### Task 4: Per-user Notion export resolution

**Files:**
- Modify: `backend/src/finalizer.ts`, `backend/src/notionBackfill.ts`, `backend/src/summaryBackfill.ts`, `backend/src/index.ts`
- Test: `backend/src/finalizer.test.ts`, `backend/src/notionBackfill.test.ts`

**Interfaces:**
- Consumes: `ExportDestinationStore.getNotion(userId)` (Task 2); the existing `createNotionExporter`, `createNotionUpdater`, `createNotionSummaryPatcher`, all taking `{ token, databaseId }`.
- Produces:
  - `interface UserExporters { export: ExportTranscript; update: UpdateExport; patchSummary: PatchSummary }`
  - `type ResolveExporters = (userId: string) => UserExporters | undefined`
  - `FinalizerOptions` loses `export` and `update`, and gains `resolve?: ResolveExporters`
  - `BackfillOptions` in both backfills loses `export` and gains `resolve: ResolveExporters`

The Notion modules themselves do not change. What changes is that they are constructed per user, at export time, from that user's stored credentials — rather than once at boot from a global env var.

- [ ] **Step 1: Write the failing test**

Add to `backend/src/finalizer.test.ts`:

```ts
  it("exports through the transcript owner's own Notion connection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wc-"));
    const seen: string[] = [];
    const resolve = (userId: string) =>
      userId === "alice"
        ? {
            export: async () => {
              seen.push("alice-export");
              return { pageId: "p1", url: "https://notion/p1" };
            },
            update: async () => ({ pageId: "p1", url: "https://notion/p1" }),
            patchSummary: async () => {},
          }
        : undefined;

    const finalize = createFinalizer({ root: dir, resolve });
    finalize(transcriptFor("alice"));
    await flush();
    expect(seen).toEqual(["alice-export"]);
  });

  it("does not export for a user with no connection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wc-"));
    const seen: string[] = [];
    const resolve = (userId: string) =>
      userId === "alice"
        ? {
            export: async () => {
              seen.push("alice-export");
              return { pageId: "p1", url: "https://notion/p1" };
            },
            update: async () => ({ pageId: "p1", url: "https://notion/p1" }),
            patchSummary: async () => {},
          }
        : undefined;

    const finalize = createFinalizer({ root: dir, resolve });
    finalize(transcriptFor("mallory"));
    await flush();
    expect(seen).toEqual([]);
  });
```

Define the two helpers at the top of that describe block, next to the existing fixtures:

```ts
function transcriptFor(userId: string): FinalizedTranscript {
  return {
    name: "2026-01-01T00-00-00Z_s1",
    userId,
    sessionId: "s1",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:01:00.000Z",
    segments: [{ at: "2026-01-01T00:00:30.000Z", text: "a".repeat(80) }],
  };
}

/** `createFinalizer` fires and forgets; let its microtasks drain. */
const flush = () => new Promise((r) => setTimeout(r, 0));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/finalizer.test.ts`
Expected: FAIL — `resolve` is not a recognised option, and no export happens

- [ ] **Step 3: Change the finalizer**

In `backend/src/finalizer.ts`, replace the `export` and `update` options:

```ts
export interface UserExporters {
  export: ExportTranscript;
  update: UpdateExport;
  patchSummary: PatchSummary;
}

/** That user's Notion connection, or undefined if they have not connected one. */
export type ResolveExporters = (userId: string) => UserExporters | undefined;

export interface FinalizerOptions {
  root: string;
  summarize?: Summarize;
  /**
   * Resolved per transcript rather than captured once, because each user
   * exports to their own workspace with their own credentials.
   */
  resolve?: ResolveExporters;
}
```

In `run()`, after the summary is written, replace the `opts.export` branch:

```ts
  const exporters = opts.resolve?.(t.userId);
  if (exporters) {
    await exportOnce(exporters.export, dir, t, summary, exporters.update);
  }
```

`PatchSummary` does **not** exist yet — `createNotionSummaryPatcher` returns an inline type. Add the named alias to `notionExporter.ts` and use it as that function's return type, so `UserExporters` has something to refer to:

```ts
/** Adds a Summary toggle to an already-exported page. */
export type PatchSummary = (pageId: string, summary: string) => Promise<void>;
```

Then change the signature to `export function createNotionSummaryPatcher(opts: NotionExporterOptions): PatchSummary`. This is a pure rename of an existing inline type — no behaviour changes.

- [ ] **Step 4: Change both backfills**

In `backend/src/notionBackfill.ts` and `backend/src/summaryBackfill.ts`, replace the `export` / `patchPage` option with `resolve: ResolveExporters`, and resolve once at the top of the sweep:

```ts
  const exporters = opts.resolve(opts.userId);
  if (!exporters) return { exported: 0, skipped: 0, failed: 0 };
```

For `summaryBackfill`, the equivalent early return keeps summarising but skips the Notion patch — a user with no Notion connection still wants their summaries written locally. Use `exporters?.patchSummary` at the patch site rather than returning early.

- [ ] **Step 5: Wire it in `index.ts`**

Replace the global `exportTranscript` construction:

```ts
const destinations = new ExportDestinationStore(db, keyFromEnv(process.env.ENCRYPTION_KEY));

/**
 * Build that user's Notion clients from their stored credentials. Constructed
 * per call rather than cached: a user can disconnect or reconnect at any time,
 * and a cached client would keep exporting to a workspace they revoked.
 */
const resolveExporters: ResolveExporters = (userId) => {
  const connection = destinations.getNotion(userId);
  if (!connection) return undefined;
  const opts = { token: connection.token, databaseId: connection.config.databaseId };
  return {
    export: createNotionExporter(opts),
    update: createNotionUpdater(opts),
    patchSummary: createNotionSummaryPatcher(opts),
  };
};
```

Pass `resolve: resolveExporters` into `createFinalizer` and into both backfill calls, replacing `export:` and `patchPage:`.

- [ ] **Step 6: Run the full suite**

Run: `cd backend && npm test && npm run build`
Expected: PASS, clean type check. Existing finalizer and backfill tests need their options renamed — expected work.

- [ ] **Step 7: Commit**

```bash
git add backend/src
git commit -m "feat(relay): export through each transcript owner's own Notion connection"
```

---

### Task 5: The Notion connect and disconnect routes

**Files:**
- Modify: `backend/src/server.ts`, `backend/src/config.ts`
- Test: `backend/src/server.exports.test.ts` (create)

**Interfaces:**
- Consumes: `OAuthStateStore`, `authorizeUrl`, `ExchangeCode` (Task 3); `ExportDestinationStore` (Task 2); `principalFor` (existing).
- Produces:
  - `GET /v1/exports` → `{ destinations: ListedDestination[] }`, authenticated
  - `GET /v1/exports/notion/start` → `302` to Notion's consent screen, authenticated
  - `GET /v1/exports/notion/callback?code&state` → `302` to `/app/exports?notion=connected` or `?notion=failed`, **unauthenticated** (Notion redirects the browser here; the `state` is what identifies the user)
  - `DELETE /v1/exports/notion` → `{ removed: boolean }`, authenticated
  - `StartServerOptions` gains `destinations?: ExportDestinationStore`, `oauthStates?: OAuthStateStore`, `notionOAuth?: NotionOAuthConfig`, `exchangeNotionCode?: ExchangeCode`

The callback cannot require a bearer token: it is a top-level browser navigation initiated by Notion. That is exactly why the `state` must be single-use and bound to the user who started the flow — it is the only thing authenticating the exchange.

- [ ] **Step 1: Write the failing test**

Create `backend/src/server.exports.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { randomBytes } from "crypto";
import { startServer, CaptionServer } from "./server";
import { openDb } from "./db";
import { IdentityStore } from "./identityStore";
import { ExportDestinationStore } from "./exportDestinations";
import { OAuthStateStore } from "./notionOAuth";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";

let server: CaptionServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const notionOAuth = {
  clientId: "client-1",
  clientSecret: "shhh",
  redirectUri: "https://relay.example/v1/exports/notion/callback",
};

function start() {
  const db = openDb(":memory:");
  const identity = new IdentityStore(db);
  const destinations = new ExportDestinationStore(db, randomBytes(32));
  const oauthStates = new OAuthStateStore(db);
  const alice = identity.registerDevice("phone");
  const mallory = identity.registerDevice("phone");
  server = startServer({
    port: 0,
    identity,
    destinations,
    oauthStates,
    notionOAuth,
    exchangeNotionCode: async (code) => {
      if (code !== "good-code") throw new Error("bad code");
      return { accessToken: "ntn_granted", databaseId: "db1", workspaceName: "Alice's Notes" };
    },
    createProvider: () => new FakeTranscriptionProvider(),
  });
  const addr = server.address();
  return {
    port: typeof addr === "object" && addr ? addr.port : 0,
    destinations,
    oauthStates,
    alice,
    mallory,
  };
}

describe("GET /v1/exports", () => {
  it("requires authentication", async () => {
    const { port } = start();
    expect((await fetch(`http://127.0.0.1:${port}/v1/exports`)).status).toBe(401);
  });

  it("lists only the caller's own destinations", async () => {
    const { port, destinations, alice, mallory } = start();
    destinations.putNotion(alice.userId, "ntn_secret", {
      databaseId: "db1",
      workspaceName: "Alice's Notes",
    });

    const mine = await fetch(`http://127.0.0.1:${port}/v1/exports`, {
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(await mine.json()).toEqual({
      destinations: [{ kind: "notion", connected: true, detail: "Alice's Notes" }],
    });

    const theirs = await fetch(`http://127.0.0.1:${port}/v1/exports`, {
      headers: { authorization: `Bearer ${mallory.token}` },
    });
    expect(await theirs.json()).toEqual({ destinations: [] });
  });

  it("never returns a secret", async () => {
    const { port, destinations, alice } = start();
    destinations.putNotion(alice.userId, "ntn_secret", { databaseId: "db1" });
    const res = await fetch(`http://127.0.0.1:${port}/v1/exports`, {
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(await res.text()).not.toContain("ntn_secret");
  });
});

describe("GET /v1/exports/notion/start", () => {
  it("redirects to Notion carrying a state", async () => {
    const { port, alice } = start();
    const res = await fetch(`http://127.0.0.1:${port}/v1/exports/notion/start`, {
      headers: { authorization: `Bearer ${alice.token}` },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://api.notion.com/v1/oauth/authorize");
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(res.headers.get("location")).not.toContain("shhh");
  });

  it("requires authentication", async () => {
    const { port } = start();
    const res = await fetch(`http://127.0.0.1:${port}/v1/exports/notion/start`, {
      redirect: "manual",
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /v1/exports/notion/callback", () => {
  it("stores the token against the user who began the flow", async () => {
    const { port, destinations, oauthStates, alice } = start();
    const state = oauthStates.mint(alice.userId);

    const res = await fetch(
      `http://127.0.0.1:${port}/v1/exports/notion/callback?code=good-code&state=${state}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/app/exports?notion=connected");
    expect(destinations.getNotion(alice.userId)).toEqual({
      token: "ntn_granted",
      config: { databaseId: "db1", workspaceName: "Alice's Notes" },
    });
  });

  it("refuses an unknown state and stores nothing", async () => {
    const { port, destinations, alice } = start();
    const res = await fetch(
      `http://127.0.0.1:${port}/v1/exports/notion/callback?code=good-code&state=forged`,
      { redirect: "manual" },
    );
    expect(res.headers.get("location")).toBe("/app/exports?notion=failed");
    expect(destinations.getNotion(alice.userId)).toBeNull();
  });

  it("refuses a replayed state", async () => {
    const { port, oauthStates, alice } = start();
    const state = oauthStates.mint(alice.userId);
    await fetch(`http://127.0.0.1:${port}/v1/exports/notion/callback?code=good-code&state=${state}`, {
      redirect: "manual",
    });
    const replay = await fetch(
      `http://127.0.0.1:${port}/v1/exports/notion/callback?code=good-code&state=${state}`,
      { redirect: "manual" },
    );
    expect(replay.headers.get("location")).toBe("/app/exports?notion=failed");
  });

  it("reports failure when Notion rejects the code, and stores nothing", async () => {
    const { port, destinations, oauthStates, alice } = start();
    const state = oauthStates.mint(alice.userId);
    const res = await fetch(
      `http://127.0.0.1:${port}/v1/exports/notion/callback?code=bad-code&state=${state}`,
      { redirect: "manual" },
    );
    expect(res.headers.get("location")).toBe("/app/exports?notion=failed");
    expect(destinations.getNotion(alice.userId)).toBeNull();
  });
});

describe("DELETE /v1/exports/notion", () => {
  it("removes only the caller's connection", async () => {
    const { port, destinations, alice, mallory } = start();
    destinations.putNotion(alice.userId, "a", { databaseId: "db1" });
    destinations.putNotion(mallory.userId, "m", { databaseId: "db2" });

    const res = await fetch(`http://127.0.0.1:${port}/v1/exports/notion`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(await res.json()).toEqual({ removed: true });
    expect(destinations.getNotion(alice.userId)).toBeNull();
    expect(destinations.getNotion(mallory.userId)).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/server.exports.test.ts`
Expected: FAIL — options are not recognised, routes 404

- [ ] **Step 3: Add the config**

In `backend/src/config.ts`, add to `Config` and `loadConfig`:

```ts
  /** Optional; enables per-user Notion export. All three parts are required. */
  notionOAuth?: NotionOAuthConfig;
  /** Base64 32-byte key sealing stored export secrets. */
  encryptionKey?: string;
  /** Public origin the OAuth redirect returns to, e.g. https://relay.fly.dev */
  publicBaseUrl?: string;
```

```ts
function loadNotionOAuth(env: NodeJS.ProcessEnv, baseUrl: string | undefined): NotionOAuthConfig | undefined {
  const clientId = env.NOTION_CLIENT_ID;
  const clientSecret = env.NOTION_CLIENT_SECRET;
  if (!clientId || !clientSecret) return undefined;
  if (!baseUrl) {
    console.warn("Notion OAuth disabled: PUBLIC_BASE_URL is required for the redirect URI");
    return undefined;
  }
  return {
    clientId,
    clientSecret,
    redirectUri: `${baseUrl.replace(/\/$/, "")}/v1/exports/notion/callback`,
  };
}
```

- [ ] **Step 4: Add the routes**

In `backend/src/server.ts`, add the four options to `StartServerOptions`, then the routes. Place them beside the other `/v1/*` handlers:

```ts
  if (req.method === "GET" && url.pathname === "/v1/exports") {
    const principal = principalFor(req, url, opts);
    if (!principal) {
      sendJSON(res, 401, { error: "unauthorized" });
      return;
    }
    sendJSON(res, 200, { destinations: opts.destinations?.list(principal.userId) ?? [] });
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/exports/notion/start") {
    const principal = principalFor(req, url, opts);
    if (!principal) {
      sendJSON(res, 401, { error: "unauthorized" });
      return;
    }
    if (!opts.notionOAuth || !opts.oauthStates) {
      sendJSON(res, 503, { error: "notion export not configured" });
      return;
    }
    const state = opts.oauthStates.mint(principal.userId);
    res.writeHead(302, { location: authorizeUrl(opts.notionOAuth, state) });
    res.end();
    return;
  }

  // Notion redirects the browser here, so there is no bearer token to check.
  // The single-use `state` is what identifies the user and what stops an
  // attacker binding their own workspace to someone else's account.
  if (req.method === "GET" && url.pathname === "/v1/exports/notion/callback") {
    const fail = () => {
      res.writeHead(302, { location: "/app/exports?notion=failed" });
      res.end();
    };
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    if (!state || !code || !opts.oauthStates || !opts.destinations || !opts.exchangeNotionCode) {
      fail();
      return;
    }
    const userId = opts.oauthStates.consume(state);
    if (!userId) {
      fail();
      return;
    }
    try {
      const granted = await opts.exchangeNotionCode(code);
      opts.destinations.putNotion(userId, granted.accessToken, {
        databaseId: granted.databaseId ?? "",
        ...(granted.workspaceName ? { workspaceName: granted.workspaceName } : {}),
      });
    } catch (err) {
      console.error("notion callback failed:", err);
      fail();
      return;
    }
    res.writeHead(302, { location: "/app/exports?notion=connected" });
    res.end();
    return;
  }

  if (req.method === "DELETE" && url.pathname === "/v1/exports/notion") {
    const principal = principalFor(req, url, opts);
    if (!principal) {
      sendJSON(res, 401, { error: "unauthorized" });
      return;
    }
    sendJSON(res, 200, { removed: opts.destinations?.remove(principal.userId, "notion") ?? false });
    return;
  }
```

- [ ] **Step 5: Run the tests**

Run: `cd backend && npx vitest run src/server.exports.test.ts && npm run build`
Expected: PASS, clean type check

- [ ] **Step 6: Commit**

```bash
git add backend/src/server.ts backend/src/config.ts backend/src/server.exports.test.ts
git commit -m "feat(relay): connect and disconnect a user's Notion workspace"
```

---

### Task 6: Email verification

**Files:**
- Modify: `backend/src/db.ts`, `backend/src/server.ts`
- Create: `backend/src/emailVerification.ts`
- Test: `backend/src/emailVerification.test.ts`, `backend/src/server.exports.test.ts`

**Interfaces:**
- Consumes: `Db`, `ExportDestinationStore`.
- Produces:
  - `class EmailVerificationStore` with `constructor(db: Db, opts?: { now?: () => number })`, `mint(userId: string, address: string): string`, `consume(token: string): { userId: string; address: string } | null`, `EMAIL_TOKEN_TTL_MS`
  - `POST /v1/exports/email` body `{ address }` → `{ pending: true }`, authenticated, rate limited
  - `GET /v1/exports/email/confirm?token=` → `302` to `/app/exports?email=confirmed|failed`, unauthenticated
  - `DELETE /v1/exports/email` → `{ removed: boolean }`, authenticated

This destination mails conversation transcripts — including the speech of bystanders — to an address the relay was told about. An unverified address makes the relay a remailer; a verified but wrong one is a privacy incident the user cannot undo. Verification is load-bearing, and the confirm endpoint is itself an abuse surface: rate limit the send, and make the token single-use and expiring.

- [ ] **Step 1: Add the table**

In `backend/src/db.ts`'s `migrate()`:

```sql
    CREATE TABLE IF NOT EXISTS email_verifications (
      token       TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      address     TEXT NOT NULL,
      expires_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS email_verifications_expires ON email_verifications(expires_at);
```

- [ ] **Step 2: Write the failing test**

Create `backend/src/emailVerification.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { openDb } from "./db";
import { IdentityStore } from "./identityStore";
import { EmailVerificationStore, EMAIL_TOKEN_TTL_MS } from "./emailVerification";

function fixture(now?: () => number) {
  const db = openDb(":memory:");
  const identity = new IdentityStore(db);
  const alice = identity.registerDevice("phone").userId;
  return { store: new EmailVerificationStore(db, now ? { now } : {}), alice };
}

describe("EmailVerificationStore", () => {
  it("round-trips a token to its user and address", () => {
    const { store, alice } = fixture();
    const token = store.mint(alice, "a@example.com");
    expect(store.consume(token)).toEqual({ userId: alice, address: "a@example.com" });
  });

  it("is single use", () => {
    const { store, alice } = fixture();
    const token = store.mint(alice, "a@example.com");
    store.consume(token);
    expect(store.consume(token)).toBeNull();
  });

  it("rejects an unknown token", () => {
    const { store } = fixture();
    expect(store.consume("forged")).toBeNull();
  });

  it("rejects an expired token", () => {
    let clock = 1_000_000;
    const { store, alice } = fixture(() => clock);
    const token = store.mint(alice, "a@example.com");
    clock += EMAIL_TOKEN_TTL_MS + 1;
    expect(store.consume(token)).toBeNull();
  });

  it("mints an unguessable token that does not embed the address", () => {
    const { store, alice } = fixture();
    const token = store.mint(alice, "a@example.com");
    expect(token.length).toBeGreaterThan(20);
    expect(token).not.toContain("a@example.com");
  });

  it("replaces a pending verification when the address changes", () => {
    const { store, alice } = fixture();
    const first = store.mint(alice, "old@example.com");
    store.mint(alice, "new@example.com");
    expect(store.consume(first)).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && npx vitest run src/emailVerification.test.ts`
Expected: FAIL — `Cannot find module './emailVerification'`

- [ ] **Step 4: Write minimal implementation**

Create `backend/src/emailVerification.ts`:

```ts
import { randomBytes } from "crypto";
import { Db } from "./db";

/** How long a confirmation link stays valid. */
export const EMAIL_TOKEN_TTL_MS = 24 * 60 * 60_000;

/**
 * Pending email confirmations.
 *
 * A user has at most one outstanding verification: minting a new one drops any
 * previous, so a mistyped address cannot be confirmed later by an old link
 * sitting in someone's inbox.
 */
export class EmailVerificationStore {
  private readonly now: () => number;

  constructor(
    private readonly db: Db,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
  }

  mint(userId: string, address: string): string {
    const stamp = new Date(this.now()).toISOString();
    this.db.prepare("DELETE FROM email_verifications WHERE expires_at <= ?").run(stamp);
    this.db.prepare("DELETE FROM email_verifications WHERE user_id = ?").run(userId);
    const token = randomBytes(32).toString("base64url");
    this.db
      .prepare("INSERT INTO email_verifications (token, user_id, address, expires_at) VALUES (?,?,?,?)")
      .run(token, userId, address, new Date(this.now() + EMAIL_TOKEN_TTL_MS).toISOString());
    return token;
  }

  consume(token: string): { userId: string; address: string } | null {
    const row = this.db
      .prepare("SELECT user_id, address, expires_at FROM email_verifications WHERE token = ?")
      .get(token) as { user_id: string; address: string; expires_at: string } | undefined;
    if (!row) return null;
    this.db.prepare("DELETE FROM email_verifications WHERE token = ?").run(token);
    if (Date.parse(row.expires_at) <= this.now()) return null;
    return { userId: row.user_id, address: row.address };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && npx vitest run src/emailVerification.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 6: Commit**

```bash
git add backend/src/db.ts backend/src/emailVerification.ts backend/src/emailVerification.test.ts
git commit -m "feat(relay): single-use expiring email confirmation tokens"
```

---

### Task 7: The email sender and its routes

**Files:**
- Create: `backend/src/emailSender.ts`
- Modify: `backend/src/server.ts`, `backend/src/config.ts`, `backend/src/finalizer.ts`
- Test: `backend/src/emailSender.test.ts`, `backend/src/server.exports.test.ts`

**Interfaces:**
- Consumes: `EmailVerificationStore`, `ExportDestinationStore`, `FinalizedTranscript`.
- Produces:
  - `interface SendEmailArgs { to: string; subject: string; text: string }`
  - `type SendEmail = (args: SendEmailArgs) => Promise<void>`
  - `function createResendSender(apiKey: string, from: string, fetchImpl?: typeof fetch): SendEmail`
  - `function transcriptEmail(t: FinalizedTranscript, summary: string | null): { subject: string; text: string }`
  - `FinalizerOptions` gains `sendTranscriptEmail?: (userId: string, t: FinalizedTranscript, summary: string | null) => Promise<void>`

Resend is a plain REST endpoint, so this needs no dependency — one `fetch` behind an injectable interface, which also makes it testable without a network.

- [ ] **Step 1: Write the failing test**

Create `backend/src/emailSender.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createResendSender, transcriptEmail } from "./emailSender";
import { FinalizedTranscript } from "./transcriptStore";

const transcript: FinalizedTranscript = {
  name: "2026-01-01T00-00-00Z_s1",
  userId: "alice",
  sessionId: "s1",
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: "2026-01-01T00:05:00.000Z",
  segments: [
    { at: "2026-01-01T00:00:30.000Z", text: "first line" },
    { at: "2026-01-01T00:01:00.000Z", text: "second line" },
  ],
};

describe("createResendSender", () => {
  it("posts the message with the api key and sender", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen = { url: String(url), init };
      return { ok: true, text: async () => "" };
    }) as unknown as typeof fetch;

    await createResendSender("re_key", "relay@example.com", fakeFetch)({
      to: "a@example.com",
      subject: "Subject",
      text: "Body",
    });

    expect(seen!.url).toBe("https://api.resend.com/emails");
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe("Bearer re_key");
    expect(JSON.parse(String(seen!.init.body))).toEqual({
      from: "relay@example.com",
      to: "a@example.com",
      subject: "Subject",
      text: "Body",
    });
  });

  it("throws when the provider rejects the send", async () => {
    const fakeFetch = (async () => ({
      ok: false,
      status: 422,
      text: async () => "domain not verified",
    })) as unknown as typeof fetch;
    await expect(
      createResendSender("re_key", "relay@example.com", fakeFetch)({
        to: "a@example.com",
        subject: "s",
        text: "t",
      }),
    ).rejects.toThrow(/422/);
  });
});

describe("transcriptEmail", () => {
  it("uses the summary title as the subject when there is one", () => {
    const { subject } = transcriptEmail(transcript, "Topic: Coffee plans\n\nThey agreed on 3pm.");
    expect(subject).toContain("Coffee plans");
  });

  it("falls back to the date when there is no summary", () => {
    const { subject } = transcriptEmail(transcript, null);
    expect(subject).toContain("2026-01-01");
  });

  it("includes the summary and every caption line", () => {
    const { text } = transcriptEmail(transcript, "Topic: Coffee plans\n\nThey agreed on 3pm.");
    expect(text).toContain("They agreed on 3pm.");
    expect(text).toContain("first line");
    expect(text).toContain("second line");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/emailSender.test.ts`
Expected: FAIL — `Cannot find module './emailSender'`

- [ ] **Step 3: Write minimal implementation**

Create `backend/src/emailSender.ts`:

```ts
import { FinalizedTranscript } from "./transcriptStore";
import { parseSummary } from "./summaryPrompt";

export interface SendEmailArgs {
  to: string;
  subject: string;
  text: string;
}

export type SendEmail = (args: SendEmailArgs) => Promise<void>;

/**
 * Resend's REST API behind one `fetch`, so email costs no dependency and stays
 * testable without a network.
 */
export function createResendSender(
  apiKey: string,
  from: string,
  fetchImpl: typeof fetch = fetch,
): SendEmail {
  return async ({ to, subject, text }) => {
    const res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to, subject, text }),
    });
    if (!res.ok) {
      throw new Error(`email send failed: ${res.status} ${await res.text()}`);
    }
  };
}

/** Plain text, because a transcript is plain text and HTML would add nothing. */
export function transcriptEmail(
  t: FinalizedTranscript,
  summary: string | null,
): { subject: string; text: string } {
  const title = summary ? parseSummary(summary).title : undefined;
  const date = t.startedAt.slice(0, 10);
  const subject = title ? `Transcript: ${title}` : `Transcript: ${date}`;
  const body = [
    summary ? `${summary}\n` : "",
    "---",
    "",
    ...t.segments.map((s) => s.text),
  ].join("\n");
  return { subject, text: body };
}
```

- [ ] **Step 4: Add the routes and config**

In `backend/src/config.ts` add `resendApiKey?` (`RESEND_API_KEY`) and `emailFrom?` (`EMAIL_FROM`).

In `backend/src/server.ts`, add `emailVerifications?: EmailVerificationStore`, `sendEmail?: SendEmail`, and `publicBaseUrl?: string` to `StartServerOptions`, then:

```ts
  if (req.method === "POST" && url.pathname === "/v1/exports/email") {
    const principal = principalFor(req, url, opts);
    if (!principal) {
      sendJSON(res, 401, { error: "unauthorized" });
      return;
    }
    if (!opts.emailVerifications || !opts.sendEmail || !opts.destinations || !opts.publicBaseUrl) {
      sendJSON(res, 503, { error: "email export not configured" });
      return;
    }
    // The relay sends mail to whatever address this call names, so an
    // unlimited caller could use it to deliver mail to strangers.
    if (!emailLimiter.allow(principal.deviceId)) {
      sendJSON(res, 429, { error: "too many verification emails" });
      return;
    }
    let body: Buffer;
    try {
      body = await readBody(req, MAX_REGISTRATION_BYTES);
    } catch {
      sendJSON(res, 413, { error: "body too large" });
      return;
    }
    let address: unknown;
    try {
      address = (JSON.parse(body.toString("utf8")) as { address?: unknown } | null)?.address;
    } catch {
      sendJSON(res, 400, { error: "invalid json" });
      return;
    }
    if (typeof address !== "string" || !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(address)) {
      sendJSON(res, 400, { error: "invalid address" });
      return;
    }
    opts.destinations.putEmail(principal.userId, { address });
    const token = opts.emailVerifications.mint(principal.userId, address);
    const link = `${opts.publicBaseUrl.replace(/\/$/, "")}/v1/exports/email/confirm?token=${token}`;
    try {
      await opts.sendEmail({
        to: address,
        subject: "Confirm transcript delivery",
        text:
          `Confirm this address to start receiving your caption transcripts:\n\n${link}\n\n` +
          `If you did not ask for this, ignore this message and nothing will be sent.`,
      });
    } catch (err) {
      console.error("verification email failed:", err);
      sendJSON(res, 502, { error: "could not send verification email" });
      return;
    }
    sendJSON(res, 200, { pending: true });
    return;
  }

  // Followed from an inbox, so there is no bearer token. The single-use token
  // is the proof, and it proves control of the address — which is the point.
  if (req.method === "GET" && url.pathname === "/v1/exports/email/confirm") {
    const token = url.searchParams.get("token");
    const claim = token && opts.emailVerifications ? opts.emailVerifications.consume(token) : null;
    if (!claim || !opts.destinations) {
      res.writeHead(302, { location: "/app/exports?email=failed" });
      res.end();
      return;
    }
    opts.destinations.putEmail(claim.userId, {
      address: claim.address,
      verifiedAt: new Date().toISOString(),
    });
    res.writeHead(302, { location: "/app/exports?email=confirmed" });
    res.end();
    return;
  }

  if (req.method === "DELETE" && url.pathname === "/v1/exports/email") {
    const principal = principalFor(req, url, opts);
    if (!principal) {
      sendJSON(res, 401, { error: "unauthorized" });
      return;
    }
    sendJSON(res, 200, { removed: opts.destinations?.remove(principal.userId, "email") ?? false });
    return;
  }
```

Add the limiter beside the existing ones in `startServer`:

```ts
  const emailLimiter = new RegistrationLimiter(undefined, EMAIL_SENDS_PER_WINDOW, EMAIL_WINDOW_MS);
```

with `const EMAIL_SENDS_PER_WINDOW = 5;` and `const EMAIL_WINDOW_MS = 60 * 60_000;` beside the other constants. Match `RegistrationLimiter`'s existing constructor signature — read it rather than assuming the argument order.

- [ ] **Step 5: Send on finalize**

In `backend/src/finalizer.ts`, add the option and call it after the Notion export, inside the same best-effort handling:

```ts
  if (opts.sendTranscriptEmail) {
    try {
      await opts.sendTranscriptEmail(t.userId, t, summary);
    } catch (err) {
      console.error(`transcript email failed for ${t.name}:`, err);
    }
  }
```

In `index.ts`, supply it, sending only to a **verified** address:

```ts
  sendTranscriptEmail: async (userId, t, summary) => {
    const destination = destinations.getEmail(userId);
    if (!destination?.verifiedAt || !sendEmail) return;
    const { subject, text } = transcriptEmail(t, summary);
    await sendEmail({ to: destination.address, subject, text });
  },
```

- [ ] **Step 6: Add the route tests**

Append to `backend/src/server.exports.test.ts` — an unverified address receives nothing; the confirm link verifies it; a forged confirm token changes nothing; the send is rate limited; a malformed address is rejected with 400. Follow the shapes already in that file, and verify each red first.

- [ ] **Step 7: Run the suite**

Run: `cd backend && npm test && npm run build`
Expected: PASS, clean type check

- [ ] **Step 8: Commit**

```bash
git add backend/src
git commit -m "feat(relay): email finished transcripts to a verified address"
```

---

### Task 8: The `/app/exports` page, migration, and docs

**Files:**
- Create: `backend/src/exportsPage.ts`
- Modify: `backend/src/server.ts`, `backend/src/viewerPage.ts`, `backend/src/index.ts`, `backend/src/config.ts`, `backend/README.md`, `backend/DEPLOY.md`
- Test: `backend/src/server.exports.test.ts`

**Interfaces:**
- Consumes: every route from Tasks 5 and 7.
- Produces: `GET /app/exports` serving `EXPORTS_HTML`; a boot migration folding the legacy env-var Notion config into the operator's destination row.

- [ ] **Step 1: Write the page**

Create `backend/src/exportsPage.ts` exporting `EXPORTS_HTML`, following `viewerPage.ts`'s existing shape: a single self-contained HTML string, the device token read from `localStorage` under the same `wc_token` key, and every data call sending `Authorization: Bearer`.

It needs: a list rendered from `GET /v1/exports`; a Connect button linking to `/v1/exports/notion/start`; an address field posting to `POST /v1/exports/email`; Disconnect buttons issuing the two `DELETE`s; and a banner reading the `?notion=` / `?email=` query parameters set by the two callbacks.

**The Connect link must carry the token**, because it is a top-level navigation and cannot set a header. Use `/v1/exports/notion/start?token=<token>` — `principalFor` already accepts a query token as a fallback. State in a comment that this is the one place a device token appears in a URL and why.

State plainly on the page that email delivery sends full transcripts, including other people's speech, to the address given.

- [ ] **Step 2: Serve it**

In `backend/src/server.ts`, beside the existing `/app` route:

```ts
  if (req.method === "GET" && url.pathname === "/app/exports") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(EXPORTS_HTML);
    return;
  }
```

Add a link to it from `viewerPage.ts`.

- [ ] **Step 3: Write the failing migration test**

Add to `backend/src/server.exports.test.ts`:

```ts
describe("legacy Notion config migration", () => {
  it("folds NOTION_TOKEN into the operator's destination row", () => {
    const db = openDb(":memory:");
    const identity = new IdentityStore(db);
    const operator = identity.registerDevice("mac").userId;
    const destinations = new ExportDestinationStore(db, randomBytes(32));

    adoptLegacyNotion(destinations, operator, { token: "ntn_legacy", databaseId: "db-legacy" });

    expect(destinations.getNotion(operator)).toEqual({
      token: "ntn_legacy",
      config: { databaseId: "db-legacy" },
    });
  });

  it("does not overwrite a connection the user already made", () => {
    const db = openDb(":memory:");
    const identity = new IdentityStore(db);
    const operator = identity.registerDevice("mac").userId;
    const destinations = new ExportDestinationStore(db, randomBytes(32));
    destinations.putNotion(operator, "ntn_current", { databaseId: "db-current" });

    adoptLegacyNotion(destinations, operator, { token: "ntn_legacy", databaseId: "db-legacy" });

    expect(destinations.getNotion(operator)!.token).toBe("ntn_current");
  });
});
```

- [ ] **Step 4: Implement the migration**

Add `adoptLegacyNotion` to `backend/src/exportDestinations.ts`:

```ts
/**
 * Carry a pre-OAuth `NOTION_TOKEN`/`NOTION_DATABASE_ID` pair onto the user who
 * owns the transcripts, so exports keep working across the upgrade. Never
 * overwrites a connection the user has since made through OAuth.
 */
export function adoptLegacyNotion(
  store: ExportDestinationStore,
  userId: string,
  legacy: { token: string; databaseId: string },
): void {
  if (store.getNotion(userId)) return;
  store.putNotion(userId, legacy.token, { databaseId: legacy.databaseId });
}
```

Call it from `index.ts` when `config.notion` is set and the boot migration reports an adopted user, logging that `NOTION_TOKEN`/`NOTION_DATABASE_ID` are now deprecated and can be unset once every user has connected through `/app/exports`.

- [ ] **Step 5: Update the docs**

`backend/README.md` and `backend/DEPLOY.md` gain the new env vars — `ENCRYPTION_KEY` (with a `openssl rand -base64 32` example), `PUBLIC_BASE_URL`, `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET`, `RESEND_API_KEY`, `EMAIL_FROM` — plus how to register the Notion public integration and which redirect URI to give it. Note that `NOTION_TOKEN`/`NOTION_DATABASE_ID` are deprecated and only still read to migrate an existing single-user setup.

- [ ] **Step 6: Run the suite**

Run: `cd backend && npm test && npm run build`
Expected: PASS, clean type check

- [ ] **Step 7: Commit**

```bash
git add backend/src backend/README.md backend/DEPLOY.md
git commit -m "feat(relay): configure export destinations from /app"
```

---

## Self-Review

**Spec coverage**

| Spec section 6 requirement | Task |
|---|---|
| `export_destinations` table, per-user rows | 2 |
| Secrets AES-256-GCM under `ENCRYPTION_KEY` | 1, 2 |
| Non-secret fields in clear text | 2 |
| Notion OAuth in the browser, relay hosts the redirect | 3, 5 |
| `state` single-use, expiring, bound to the session | 3, 5 |
| `client_secret` never leaves the server | 3 |
| No refresh machinery; a revoked token surfaces as 401 | 4 (resolver rebuilt per call) |
| Notion modules retained, read per-user credentials | 4 |
| Email sent relay-side, automatically, after summarization | 7 |
| Address ownership verified before the first transcript | 6, 7 |
| Confirmation endpoint rate limited, token single-use and expiring | 6, 7 |
| Legacy `NOTION_TOKEN` migration | 8 |
| Configuration in `/app` (2026-08-15 amendment) | 8 |

Files/iCloud and share sheet are deliberately absent — Plan 3.

**Known ordering note**

Task 4 changes `FinalizerOptions` and both backfills, so the existing `finalizer.test.ts`, `notionBackfill.test.ts`, and `summaryBackfill.test.ts` need their options renamed in that task. That is expected work, not scope creep.

**Deferred**

- A revoked Notion token surfaces as a 401 and is logged, but nothing marks the destination as needing re-authorization in the store. `/app` shows it as connected until the user checks. Worth a follow-up.
- No retry or dead-letter for a failed transcript email; the Notion path has `notionBackfill` as its retry, email has none.
- `oauth_states` and `email_verifications` are swept on mint, matching `pairing_codes`. Neither has a background sweep.
