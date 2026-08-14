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

  it("is idempotent across a restart with new per-user content", () => {
    // Simulates a second boot: the first migration already ran (in a prior
    // process) and left only per-user subdirectories at the root, with no
    // loose files. A fresh IdentityStore/process must still see this as
    // "nothing to migrate" rather than minting another adopted user.
    const root = mkdtempSync(join(tmpdir(), "wc-"));
    const identity = identityStore();
    const first = migrateFlatTranscripts(
      root,
      (() => {
        // Seed a loose file so the first "boot" actually migrates something.
        writeFileSync(join(root, "2026-01-01T00-00-00Z_s1.jsonl"), '{"at":"x","text":"hi"}\n');
        return identity;
      })(),
    );
    expect(first).not.toBeNull();
    expect(readdirSync(root)).toEqual([first!.userId]);

    // "Restart": a fresh IdentityStore instance (as boot would create), same
    // on-disk root, which now holds only the per-user directory.
    const restarted = identityStore();
    const second = migrateFlatTranscripts(root, restarted);
    expect(second).toBeNull();
    expect(readdirSync(root)).toEqual([first!.userId]);
  });
});
