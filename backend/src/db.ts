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
  `);
}
