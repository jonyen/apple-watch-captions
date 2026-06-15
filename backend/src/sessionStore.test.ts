import { describe, it, expect } from "vitest";
import { SessionStore } from "./sessionStore";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";

function makeStore(opts?: { idleTimeoutMs?: number; now?: () => number }) {
  const providers: FakeTranscriptionProvider[] = [];
  const store = new SessionStore({
    createProvider: () => {
      const p = new FakeTranscriptionProvider();
      providers.push(p);
      return p;
    },
    idleTimeoutMs: opts?.idleTimeoutMs,
    now: opts?.now,
  });
  return { store, providers };
}

describe("SessionStore", () => {
  it("creates a session on first feed and forwards audio to the provider", () => {
    const { store, providers } = makeStore();
    store.feed("s1", Buffer.from("abc"));
    expect(providers).toHaveLength(1);
    expect(Buffer.concat(providers[0].receivedAudio).toString()).toBe("abc");
  });

  it("ignores empty audio but still creates/keeps the session", () => {
    const { store, providers } = makeStore();
    store.feed("s1", Buffer.alloc(0));
    expect(store.has("s1")).toBe(true);
    expect(providers[0].receivedAudio).toHaveLength(0);
  });

  it("buffers outbound messages with monotonic seq and drains seq>since", () => {
    const { store, providers } = makeStore();
    store.feed("s1", Buffer.alloc(0));
    const p = providers[0];
    p.emitReady();
    p.emitTranscript({ text: "hello", isFinal: false });
    p.emitTranscript({ text: "hello world", isFinal: true });

    const all = store.drain("s1", 0);
    expect(all.seq).toBe(3);
    expect(all.events).toEqual([
      { seq: 1, payload: { type: "ready" } },
      { seq: 2, payload: { type: "caption", text: "hello", isFinal: false } },
      { seq: 3, payload: { type: "caption", text: "hello world", isFinal: true } },
    ]);

    // After acking seq 2, only seq 3 remains.
    const rest = store.drain("s1", 2);
    expect(rest.events.map((e) => e.seq)).toEqual([3]);
  });

  it("returns nothing for an unknown session", () => {
    const { store } = makeStore();
    expect(store.drain("nope", 0)).toEqual({ events: [], seq: 0 });
  });

  it("closes the provider on stop and forgets the session", () => {
    const { store, providers } = makeStore();
    store.feed("s1", Buffer.alloc(0));
    store.stop("s1");
    expect(providers[0].closed).toBe(true);
    expect(store.has("s1")).toBe(false);
  });

  it("reaps idle sessions past the timeout", () => {
    let t = 1000;
    const { store, providers } = makeStore({ idleTimeoutMs: 100, now: () => t });
    store.feed("s1", Buffer.alloc(0));
    t = 1050;
    store.reapIdle();
    expect(store.has("s1")).toBe(true); // within timeout
    t = 1200;
    store.reapIdle();
    expect(store.has("s1")).toBe(false); // past timeout
    expect(providers[0].closed).toBe(true);
  });

  it("keeps a session alive when fed within the timeout", () => {
    let t = 1000;
    const { store } = makeStore({ idleTimeoutMs: 100, now: () => t });
    store.feed("s1", Buffer.alloc(0));
    t = 1080;
    store.feed("s1", Buffer.alloc(0)); // refresh activity
    t = 1150;
    store.reapIdle();
    expect(store.has("s1")).toBe(true);
  });
});
