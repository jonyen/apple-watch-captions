import { describe, it, expect } from "vitest";
import { openDb } from "./db";
import { IdentityStore } from "./identityStore";
import { EmailVerificationStore, EMAIL_TOKEN_TTL_MS } from "./emailVerification";

function fixture(now?: () => number) {
  const db = openDb(":memory:");
  const identity = new IdentityStore(db);
  const alice = identity.registerDevice("phone").userId;
  const bob = identity.registerDevice("phone").userId;
  return { db, store: new EmailVerificationStore(db, now ? { now } : {}), alice, bob };
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
    const { db, store, alice } = fixture(() => clock);
    const token = store.mint(alice, "a@example.com");
    clock += EMAIL_TOKEN_TTL_MS + 1;
    expect(store.consume(token)).toBeNull();
    // Not just null back from consume — the row itself must be gone, which is
    // only true if expiry is checked *after* the delete. A regression to
    // checking expiry first (and only deleting a still-valid token) would
    // also return null here, but would leave the expired row retryable.
    expect(
      db.prepare("SELECT 1 FROM email_verifications WHERE token = ?").get(token),
    ).toBeUndefined();
  });

  it("mints an unguessable token that does not embed the address", () => {
    const { store, alice } = fixture();
    const token = store.mint(alice, "a@example.com");
    expect(token.length).toBeGreaterThan(20);
    expect(token).not.toContain("a@example.com");
    // Length and address-absence alone are satisfied by a deterministic
    // derivation (e.g. a hash of the address, or a padded counter). Minting
    // twice for the same user and address must produce different tokens, or
    // the token isn't actually unguessable.
    const second = store.mint(alice, "a@example.com");
    expect(second).not.toBe(token);
  });

  it("replaces a pending verification when the address changes", () => {
    const { store, alice } = fixture();
    const first = store.mint(alice, "old@example.com");
    store.mint(alice, "new@example.com");
    expect(store.consume(first)).toBeNull();
  });

  it("does not disturb another user's pending verification", () => {
    const { store, alice, bob } = fixture();
    const bobToken = store.mint(bob, "bob@example.com");
    store.mint(alice, "alice@example.com");
    expect(store.consume(bobToken)).toEqual({ userId: bob, address: "bob@example.com" });
  });
});
