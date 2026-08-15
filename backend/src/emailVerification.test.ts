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
