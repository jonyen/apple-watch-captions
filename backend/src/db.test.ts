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
