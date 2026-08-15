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

describe("ExportDestinationStore legacy Notion resolution marker", () => {
  it("is unresolved for a user nothing has touched", () => {
    const { store, alice } = fixture();
    expect(store.hasResolvedLegacyNotion(alice)).toBe(false);
  });

  it("is resolved after being marked", () => {
    const { store, alice } = fixture();
    store.markLegacyNotionResolved(alice);
    expect(store.hasResolvedLegacyNotion(alice)).toBe(true);
  });

  it("does not mark other users as resolved", () => {
    const { store, alice, mallory } = fixture();
    store.markLegacyNotionResolved(alice);
    expect(store.hasResolvedLegacyNotion(mallory)).toBe(false);
  });

  // The whole point of this marker: it must outlive the row it originally
  // accompanied, or a Disconnect (which deletes that row) would look
  // indistinguishable from "never resolved" and get silently re-adopted.
  it("survives the user's notion destination being removed", () => {
    const { store, alice } = fixture();
    store.putNotion(alice, "ntn_secret", { databaseId: "db1" });
    store.markLegacyNotionResolved(alice);
    store.remove(alice, "notion");
    expect(store.hasResolvedLegacyNotion(alice)).toBe(true);
  });

  it("marking twice does not error", () => {
    const { store, alice } = fixture();
    store.markLegacyNotionResolved(alice);
    expect(() => store.markLegacyNotionResolved(alice)).not.toThrow();
    expect(store.hasResolvedLegacyNotion(alice)).toBe(true);
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
