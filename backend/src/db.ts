import type { DatabaseSync as DatabaseSyncClass } from "node:sqlite";

export type Db = DatabaseSyncClass;

// vitest's module runner (vite-node@2.1.9, bundled with the installed
// vitest@2.1.9) only recognizes a "node:x" specifier as a Node builtin
// when the bare name "x" is *also* a builtin module in its own right. Newer
// core modules like "node:sqlite" have no such bare alias, so a static
// `import { DatabaseSync } from "node:sqlite"` gets misclassified as a
// regular package and fails to resolve under `vitest run` — even though
// Node itself resolves it fine. `process.getBuiltinModule` sidesteps module
// resolution entirely, so it works identically under tsx (production) and
// vitest (tests).
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

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
    -- Support the purge that issuePairingCode runs before allocating:
    -- unindexed it is a full-table scan, on the single SQLite writer every
    -- other request queues behind, driven by a client-callable endpoint.
    --
    -- Two indexes, one per predicate, because the purge is two statements
    -- rather than one "consumed_at IS NOT NULL OR expires_at <= ?". Verified
    -- with EXPLAIN QUERY PLAN: SQLite plans the OR form as a plain SCAN
    -- whatever indexes exist, unless ANALYZE has been run (which nothing
    -- here does) — so a single index against the OR would have been
    -- decorative. Split, each half is an indexed SEARCH with no stats.
    --
    -- IF NOT EXISTS (like every statement here) so a database created before
    -- these indexes picks them up on its next boot.
    CREATE INDEX IF NOT EXISTS pairing_codes_purge
      ON pairing_codes(consumed_at, expires_at);
    CREATE INDEX IF NOT EXISTS pairing_codes_expires
      ON pairing_codes(expires_at);

    CREATE TABLE IF NOT EXISTS export_destinations (
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL CHECK (kind IN ('notion','email')),
      config      TEXT NOT NULL,
      secret      TEXT,
      created_at  TEXT NOT NULL,
      PRIMARY KEY (user_id, kind)
    );

    CREATE TABLE IF NOT EXISTS oauth_states (
      state       TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS oauth_states_expires ON oauth_states(expires_at);

    CREATE TABLE IF NOT EXISTS email_verifications (
      token       TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      address     TEXT NOT NULL,
      expires_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS email_verifications_expires ON email_verifications(expires_at);

    -- One-time marker: has the legacy NOTION_TOKEN/NOTION_DATABASE_ID pair
    -- already been resolved (adopted, or found already connected) for this
    -- user? Deliberately its own table rather than a flag on
    -- export_destinations: that row is exactly what a user's Disconnect
    -- deletes, and this marker's entire purpose is to survive that delete —
    -- once a user has been resolved, the boot-time legacy-Notion adoption
    -- must never touch them again, or a deliberate Disconnect would be
    -- silently undone by the next redeploy. Never deleted by this relay.
    CREATE TABLE IF NOT EXISTS legacy_notion_resolutions (
      user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      resolved_at  TEXT NOT NULL
    );
  `);
}
