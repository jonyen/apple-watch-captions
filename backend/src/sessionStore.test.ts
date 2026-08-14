import { describe, it, expect } from "vitest";
import { SessionStore } from "./sessionStore";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";
import { ProviderOptions } from "./providerOptions";

function makeStore(opts?: { idleTimeoutMs?: number; now?: () => number }) {
  const providers: FakeTranscriptionProvider[] = [];
  const appended: string[] = [];
  const finalized: string[] = [];
  const transcripts = {
    append: (_id: string, text: string) => appended.push(text),
    finalize: (id: string) => finalized.push(id),
    reopen: () => {},
    finalizeAll: () => {},
    activeName: () => undefined,
  } as any;
  const store = new SessionStore({
    createProvider: () => {
      const p = new FakeTranscriptionProvider();
      providers.push(p);
      return p;
    },
    idleTimeoutMs: opts?.idleTimeoutMs,
    now: opts?.now,
    transcripts,
  });
  return { store, providers, appended, finalized };
}

describe("SessionStore", () => {
  it("creates a session on first feed and forwards audio to the provider", () => {
    const { store, providers } = makeStore();
    store.feed("u1", "s1", Buffer.from("abc"));
    expect(providers).toHaveLength(1);
    expect(Buffer.concat(providers[0].receivedAudio).toString()).toBe("abc");
  });

  it("ignores empty audio but still creates/keeps the session", () => {
    const { store, providers } = makeStore();
    store.feed("u1", "s1", Buffer.alloc(0));
    expect(store.has("u1", "s1")).toBe(true);
    expect(providers[0].receivedAudio).toHaveLength(0);
  });

  it("buffers outbound messages with monotonic seq and drains seq>since", () => {
    const { store, providers } = makeStore();
    store.feed("u1", "s1", Buffer.alloc(0));
    const p = providers[0];
    p.emitReady();
    p.emitTranscript({ text: "hello", isFinal: false });
    p.emitTranscript({ text: "hello world", isFinal: true });

    const all = store.drain("u1", "s1", 0);
    expect(all.seq).toBe(3);
    expect(all.events).toEqual([
      { seq: 1, payload: { type: "ready" } },
      { seq: 2, payload: { type: "caption", text: "hello", isFinal: false } },
      { seq: 3, payload: { type: "caption", text: "hello world", isFinal: true } },
    ]);

    // After acking seq 2, only seq 3 remains.
    const rest = store.drain("u1", "s1", 2);
    expect(rest.events.map((e) => e.seq)).toEqual([3]);
  });

  it("returns nothing for an unknown session", () => {
    const { store } = makeStore();
    expect(store.drain("u1", "nope", 0)).toEqual({ events: [], seq: 0 });
  });

  it("closes the provider on stop and forgets the session", () => {
    const { store, providers } = makeStore();
    store.feed("u1", "s1", Buffer.alloc(0));
    store.stop("u1", "s1");
    expect(providers[0].closed).toBe(true);
    expect(store.has("u1", "s1")).toBe(false);
  });

  it("reaps idle sessions past the timeout", () => {
    let t = 1000;
    const { store, providers } = makeStore({ idleTimeoutMs: 100, now: () => t });
    store.feed("u1", "s1", Buffer.alloc(0));
    t = 1050;
    store.reapIdle();
    expect(store.has("u1", "s1")).toBe(true); // within timeout
    t = 1200;
    store.reapIdle();
    expect(store.has("u1", "s1")).toBe(false); // past timeout
    expect(providers[0].closed).toBe(true);
  });

  it("keeps a session alive when fed within the timeout", () => {
    let t = 1000;
    const { store } = makeStore({ idleTimeoutMs: 100, now: () => t });
    store.feed("u1", "s1", Buffer.alloc(0));
    t = 1080;
    store.feed("u1", "s1", Buffer.alloc(0)); // refresh activity
    t = 1150;
    store.reapIdle();
    expect(store.has("u1", "s1")).toBe(true);
  });

  it("keeps identically named sessions from different users apart", () => {
    const store = new SessionStore({ createProvider: () => new FakeTranscriptionProvider() });
    store.feed("user-a", "shared-id", Buffer.from([1, 2, 3, 4]));
    expect(store.has("user-a", "shared-id")).toBe(true);
    expect(store.has("user-b", "shared-id")).toBe(false);
  });

  it("does not drain another user's events", () => {
    const providers: FakeTranscriptionProvider[] = [];
    const store = new SessionStore({
      createProvider: () => {
        const p = new FakeTranscriptionProvider();
        providers.push(p);
        return p;
      },
    });
    store.feed("user-a", "shared-id", Buffer.from([1, 2, 3, 4]));
    // A real event, driven explicitly — FakeTranscriptionProvider emits
    // nothing on its own, so an assertion of `[]` here would pass whether or
    // not isolation actually holds unless something was really emitted.
    providers[0].emitTranscript({ text: "secret", isFinal: true });

    expect(store.drain("user-b", "shared-id", 0).events).toEqual([]);

    // And user A must still see it — proving this is isolation, not just
    // everything being broken.
    const own = store.drain("user-a", "shared-id", 0);
    expect(
      own.events.some((e) => e.payload.type === "caption" && e.payload.text === "secret"),
    ).toBe(true);
  });

  it("does not stop another user's session", () => {
    const store = new SessionStore({ createProvider: () => new FakeTranscriptionProvider() });
    store.feed("user-a", "shared-id", Buffer.from([1, 2, 3, 4]));
    store.stop("user-b", "shared-id");
    expect(store.has("user-a", "shared-id")).toBe(true);
  });
});

describe("SessionStore ephemeral sessions", () => {
  it("appends nothing and finalizes nothing for an ephemeral session", () => {
    const { store, providers, appended, finalized } = makeStore();
    store.feed("u1", "s1", Buffer.alloc(0), true);
    providers[0].emitTranscript({ text: "off the record", isFinal: true });
    store.stop("u1", "s1");
    expect(appended).toEqual([]);
    expect(finalized).toEqual([]);
  });

  it("still persists a normal session", () => {
    const { store, providers, appended, finalized } = makeStore();
    store.feed("u1", "s1", Buffer.alloc(0));
    providers[0].emitTranscript({ text: "on the record", isFinal: true });
    store.stop("u1", "s1");
    expect(appended).toEqual(["on the record"]);
    expect(finalized).toEqual(["s1"]);
  });

  it("stays ephemeral when a later feed omits the flag", () => {
    const { store, providers, appended, finalized } = makeStore();
    store.feed("u1", "s1", Buffer.alloc(0), true);
    store.feed("u1", "s1", Buffer.from("more audio"));   // flag absent
    providers[0].emitTranscript({ text: "still off", isFinal: true });
    store.stop("u1", "s1");
    expect(appended).toEqual([]);
    expect(finalized).toEqual([]);
  });

  it("stays saved when a later feed sets the flag", () => {
    const { store, providers, appended } = makeStore();
    store.feed("u1", "s1", Buffer.alloc(0));
    store.feed("u1", "s1", Buffer.from("more audio"), true);   // must not take effect
    providers[0].emitTranscript({ text: "on the record", isFinal: true });
    expect(appended).toEqual(["on the record"]);
  });

  it("does not finalize an ephemeral session that is reaped for idleness", () => {
    let clock = 0;
    const { store, providers, finalized } = makeStore({
      idleTimeoutMs: 100,
      now: () => clock,
    });
    store.feed("u1", "s1", Buffer.alloc(0), true);
    providers[0].emitTranscript({ text: "off the record", isFinal: true });
    clock = 1000;
    store.reapIdle();
    expect(store.has("u1", "s1")).toBe(false);
    expect(finalized).toEqual([]);
  });

  it("does not finalize an ephemeral session on closeAll", () => {
    const { store, providers, finalized } = makeStore();
    store.feed("u1", "s1", Buffer.alloc(0), true);
    store.feed("u1", "s2", Buffer.alloc(0));
    providers[0].emitTranscript({ text: "off", isFinal: true });
    providers[1].emitTranscript({ text: "on", isFinal: true });
    store.closeAll();
    expect(finalized).toEqual(["s2"]);
  });

  it("reports whether a session is ephemeral", () => {
    const { store } = makeStore();
    store.feed("u1", "live", Buffer.alloc(0), true);
    store.feed("u1", "saved", Buffer.alloc(0));
    expect(store.isEphemeral("u1", "live")).toBe(true);
    expect(store.isEphemeral("u1", "saved")).toBe(false);
    expect(store.isEphemeral("u1", "unknown")).toBe(false);
  });
});

describe("provider options", () => {
  it("passes them to the factory when the session is created", () => {
    const seen: (ProviderOptions | undefined)[] = [];
    const store = new SessionStore({
      createProvider: (opts) => {
        seen.push(opts);
        return new FakeTranscriptionProvider();
      },
    });

    store.feed("u1", "s1", Buffer.alloc(0), true, { telephony: true });

    expect(seen).toEqual([{ telephony: true }]);
  });

  // The provider is built once, at creation. A later post cannot change what
  // a conversation already in progress is being transcribed as.
  it("ignores them for a session that already exists", () => {
    const seen: (ProviderOptions | undefined)[] = [];
    const store = new SessionStore({
      createProvider: (opts) => {
        seen.push(opts);
        return new FakeTranscriptionProvider();
      },
    });

    store.feed("u1", "s1", Buffer.alloc(0), true, { telephony: true });
    store.feed("u1", "s1", Buffer.alloc(0), true, { telephony: false });

    expect(seen).toHaveLength(1);
  });
});
