import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
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

  // Every issued pairing code purges dead rows first, and that purge runs on
  // the single SQLite writer every other request queues behind. Unindexed it
  // is a full-table scan, on a path a client can drive. Asserted through the
  // query planner rather than by listing index names, because an index the
  // planner declines to use is not a fix: SQLite falls back to `SCAN` here
  // the moment either predicate loses its index.
  it("indexes both halves of the pairing-code purge", () => {
    const db = openDb(":memory:");
    const planFor = (sql: string) =>
      db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all()
        .map((row) => (row as { detail: string }).detail)
        .join(" ");

    // "COVERING INDEX" when SQLite can answer from the index alone.
    const indexed = /USING (COVERING )?INDEX/;
    expect(planFor("DELETE FROM pairing_codes WHERE consumed_at IS NOT NULL"))
      .toMatch(indexed);
    expect(planFor("DELETE FROM pairing_codes WHERE expires_at <= ?"))
      .toMatch(indexed);
  });

  it("adds the purge index to a database created without it", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "db-test-"));
    const dbPath = path.join(dir, "identity.sqlite");
    const db1 = openDb(dbPath);
    db1.exec("DROP INDEX pairing_codes_purge");
    db1.close();

    const db2 = openDb(dbPath);

    const names = db2
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(names).toContain("pairing_codes_purge");
    db2.close();
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
    const dir = mkdtempSync(path.join(tmpdir(), "db-test-"));
    const dbPath = path.join(dir, "identity.sqlite");

    const db1 = openDb(dbPath);
    db1.prepare("INSERT INTO users (id, created_at) VALUES (?,?)").run("u1", "2026-08-14T00:00:00Z");
    db1.close();

    expect(() => openDb(dbPath)).not.toThrow();

    const db2 = openDb(dbPath);
    const row = db2.prepare("SELECT count(*) AS n FROM users").get() as { n: number };
    expect(row.n).toBe(1);
  });
});
