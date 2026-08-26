import { describe, it, expect, vi } from "vitest";
import { SessionStore } from "./sessionStore";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";
import { ProviderOptions } from "./providerOptions";

function makeStore(opts?: { idleTimeoutMs?: number; now?: () => number }) {
  const providers: FakeTranscriptionProvider[] = [];
  const appended: string[] = [];
  const finalized: string[] = [];
  const transcripts = {
    append: (_userId: string, _id: string, text: string) => appended.push(text),
    finalize: (_userId: string, id: string) => finalized.push(id),
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

  it("closes the provider on stop and forgets the session", async () => {
    const { store, providers } = makeStore();
    store.feed("u1", "s1", Buffer.alloc(0));
    await store.stop("u1", "s1");
    expect(providers[0].closed).toBe(true);
    expect(store.has("u1", "s1")).toBe(false);
  });

  it("reaps idle sessions past the timeout", async () => {
    let t = 1000;
    const { store, providers } = makeStore({ idleTimeoutMs: 100, now: () => t });
    store.feed("u1", "s1", Buffer.alloc(0));
    t = 1050;
    await store.reapIdle();
    expect(store.has("u1", "s1")).toBe(true); // within timeout
    t = 1200;
    await store.reapIdle();
    expect(store.has("u1", "s1")).toBe(false); // past timeout
    expect(providers[0].closed).toBe(true);
  });

  it("keeps a session alive when fed within the timeout", async () => {
    let t = 1000;
    const { store } = makeStore({ idleTimeoutMs: 100, now: () => t });
    store.feed("u1", "s1", Buffer.alloc(0));
    t = 1080;
    store.feed("u1", "s1", Buffer.alloc(0)); // refresh activity
    t = 1150;
    await store.reapIdle();
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

  it("does not stop another user's session", async () => {
    const store = new SessionStore({ createProvider: () => new FakeTranscriptionProvider() });
    store.feed("user-a", "shared-id", Buffer.from([1, 2, 3, 4]));
    await store.stop("user-b", "shared-id");
    expect(store.has("user-a", "shared-id")).toBe(true);
  });
});

describe("SessionStore ephemeral sessions", () => {
  it("appends nothing and finalizes nothing for an ephemeral session", async () => {
    const { store, providers, appended, finalized } = makeStore();
    store.feed("u1", "s1", Buffer.alloc(0), true);
    providers[0].emitTranscript({ text: "off the record", isFinal: true });
    await store.stop("u1", "s1");
    expect(appended).toEqual([]);
    expect(finalized).toEqual([]);
  });

  it("still persists a normal session", async () => {
    const { store, providers, appended, finalized } = makeStore();
    store.feed("u1", "s1", Buffer.alloc(0));
    providers[0].emitTranscript({ text: "on the record", isFinal: true });
    await store.stop("u1", "s1");
    expect(appended).toEqual(["on the record"]);
    expect(finalized).toEqual(["s1"]);
  });

  it("stays ephemeral when a later feed omits the flag", async () => {
    const { store, providers, appended, finalized } = makeStore();
    store.feed("u1", "s1", Buffer.alloc(0), true);
    store.feed("u1", "s1", Buffer.from("more audio"));   // flag absent
    providers[0].emitTranscript({ text: "still off", isFinal: true });
    await store.stop("u1", "s1");
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

  it("does not finalize an ephemeral session that is reaped for idleness", async () => {
    let clock = 0;
    const { store, providers, finalized } = makeStore({
      idleTimeoutMs: 100,
      now: () => clock,
    });
    store.feed("u1", "s1", Buffer.alloc(0), true);
    providers[0].emitTranscript({ text: "off the record", isFinal: true });
    clock = 1000;
    await store.reapIdle();
    expect(store.has("u1", "s1")).toBe(false);
    expect(finalized).toEqual([]);
  });

  it("does not finalize an ephemeral session on closeAll", async () => {
    const { store, providers, finalized } = makeStore();
    store.feed("u1", "s1", Buffer.alloc(0), true);
    store.feed("u1", "s2", Buffer.alloc(0));
    providers[0].emitTranscript({ text: "off", isFinal: true });
    providers[1].emitTranscript({ text: "on", isFinal: true });
    await store.closeAll();
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

describe("SessionStore caption injection", () => {
  it("creates a caption-only session with no transcription provider", () => {
    const { store, providers } = makeStore();
    store.injectCaptions("u1", "s1", [{ text: "hi", isFinal: false }]);
    expect(store.has("u1", "s1")).toBe(true);
    expect(providers).toHaveLength(0);
  });

  it("buffers injected lines like provider captions and appends only finals", () => {
    const { store, appended } = makeStore();
    store.injectCaptions("u1", "s1", [
      { text: "hel", isFinal: false },
      { text: "hello world", isFinal: true },
    ]);
    const { events, seq } = store.drain("u1", "s1", 0);
    expect(seq).toBe(2);
    expect(events.map((e) => e.payload)).toEqual([
      { type: "caption", text: "hel", isFinal: false },
      { type: "caption", text: "hello world", isFinal: true },
    ]);
    expect(appended).toEqual(["hello world"]);
  });

  it("finalizes a caption-only session on stop and on idle reap, like audio", async () => {
    let t = 0;
    const { store, finalized } = makeStore({ idleTimeoutMs: 100, now: () => t });
    store.injectCaptions("u1", "s1", [{ text: "kept.", isFinal: true }]);
    await store.stop("u1", "s1");
    expect(finalized).toEqual(["s1"]);

    store.injectCaptions("u1", "s2", [{ text: "kept too.", isFinal: true }]);
    t = 1000;
    await store.reapIdle();
    expect(store.has("u1", "s2")).toBe(false);
    expect(finalized).toEqual(["s1", "s2"]);
  });

  it("injects into an existing audio session rather than replacing it", () => {
    const { store, providers, appended } = makeStore();
    store.feed("u1", "s1", Buffer.from("audio"));
    store.injectCaptions("u1", "s1", [{ text: "typed.", isFinal: true }]);
    expect(providers).toHaveLength(1); // the audio session's provider, untouched
    expect(appended).toEqual(["typed."]);
  });

  it("refreshes activity, so injecting keeps the session alive", async () => {
    let t = 0;
    const { store } = makeStore({ idleTimeoutMs: 100, now: () => t });
    store.injectCaptions("u1", "s1", [{ text: "x", isFinal: true }]);
    t = 80;
    store.injectCaptions("u1", "s1", []); // empty batch still counts as activity
    t = 150;
    await store.reapIdle();
    expect(store.has("u1", "s1")).toBe(true);
  });
});

describe("SessionStore training capture wiring", () => {
  function fakeCapture() {
    const audioCalls: [string, string, string, Buffer][] = [];
    const discardCalls: [string, string][] = [];
    return {
      audioCalls,
      discardCalls,
      capture: {
        audio: (userId: string, id: string, provider: string, chunk: Buffer) =>
          audioCalls.push([userId, id, provider, chunk]),
        discardIfPending: (userId: string, id: string) => discardCalls.push([userId, id]),
        finalize: () => {},
        archiveFinalize: async () => {},
      } as any,
    };
  }

  it("forwards audio chunks to the capture for a normal audio session", () => {
    const { capture, audioCalls } = fakeCapture();
    const store = new SessionStore({
      createProvider: () => new FakeTranscriptionProvider(),
      trainingCapture: capture,
      defaultProviderName: "apple",
    });
    store.feed("u1", "s1", Buffer.from("pcm"));
    expect(audioCalls).toEqual([["u1", "s1", "apple", Buffer.from("pcm")]]);
  });

  it("uses the session's requested provider, not the default, when one was requested", () => {
    const { capture, audioCalls } = fakeCapture();
    const store = new SessionStore({
      createProvider: () => new FakeTranscriptionProvider(),
      trainingCapture: capture,
      defaultProviderName: "apple",
    });
    store.feed("u1", "s1", Buffer.from("pcm"), false, { provider: "openai" });
    expect(audioCalls[0]![2]).toBe("openai");
  });

  it("never forwards audio for a caption-only session", () => {
    const { capture, audioCalls } = fakeCapture();
    const store = new SessionStore({
      createProvider: () => new FakeTranscriptionProvider(),
      trainingCapture: capture,
    });
    store.injectCaptions("u1", "s1", [{ text: "hi", isFinal: true }]);
    expect(audioCalls).toEqual([]);
  });

  it("never forwards audio for an ephemeral session", () => {
    const { capture, audioCalls } = fakeCapture();
    const store = new SessionStore({
      createProvider: () => new FakeTranscriptionProvider(),
      trainingCapture: capture,
    });
    store.feed("u1", "s1", Buffer.from("pcm"), true);
    expect(audioCalls).toEqual([]);
  });

  it("calls discardIfPending on stop for a saved session", async () => {
    const { capture, discardCalls } = fakeCapture();
    const store = new SessionStore({
      createProvider: () => new FakeTranscriptionProvider(),
      trainingCapture: capture,
    });
    store.feed("u1", "s1", Buffer.from("pcm"));
    await store.stop("u1", "s1");
    expect(discardCalls).toEqual([["u1", "s1"]]);
  });

  it("does not call discardIfPending on stop for an ephemeral session", async () => {
    const { capture, discardCalls } = fakeCapture();
    const store = new SessionStore({
      createProvider: () => new FakeTranscriptionProvider(),
      trainingCapture: capture,
    });
    store.feed("u1", "s1", Buffer.from("pcm"), true);
    await store.stop("u1", "s1");
    expect(discardCalls).toEqual([]);
  });

  it("calls discardIfPending on reapIdle and closeAll too", async () => {
    let t = 0;
    const { capture, discardCalls } = fakeCapture();
    const store = new SessionStore({
      createProvider: () => new FakeTranscriptionProvider(),
      trainingCapture: capture,
      idleTimeoutMs: 100,
      now: () => t,
    });
    store.feed("u1", "s1", Buffer.from("pcm"));
    t = 1000;
    await store.reapIdle();
    expect(discardCalls).toEqual([["u1", "s1"]]);

    store.feed("u1", "s2", Buffer.from("pcm"));
    await store.closeAll();
    expect(discardCalls).toEqual([
      ["u1", "s1"],
      ["u1", "s2"],
    ]);
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

    store.feed("u1", "s1", Buffer.alloc(0), true, { provider: "apple" });

    expect(seen).toEqual([{ provider: "apple" }]);
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

    store.feed("u1", "s1", Buffer.alloc(0), true, { provider: "apple" });
    store.feed("u1", "s1", Buffer.alloc(0), true, { provider: "openai" });

    expect(seen).toHaveLength(1);
  });
});

describe("SessionStore.feedArchive", () => {
  function fakeCapture() {
    const archiveAudioCalls: [string, string, Buffer][] = [];
    const archiveFinalizeCalls: [string, string][] = [];
    return {
      archiveAudioCalls,
      archiveFinalizeCalls,
      capture: {
        audio: () => {},
        discardIfPending: () => {},
        finalize: () => {},
        archiveAudio: (userId: string, id: string, chunk: Buffer) =>
          archiveAudioCalls.push([userId, id, chunk]),
        archiveFinalize: async (userId: string, id: string) => {
          archiveFinalizeCalls.push([userId, id]);
        },
      } as any,
    };
  }

  it("forwards archived PCM straight to TrainingCapture.archiveAudio", () => {
    const { capture, archiveAudioCalls } = fakeCapture();
    const store = new SessionStore({
      createProvider: () => new FakeTranscriptionProvider(),
      trainingCapture: capture,
    });
    store.feedArchive("u1", "s1", Buffer.from("pcm"));
    expect(archiveAudioCalls).toEqual([["u1", "s1", Buffer.from("pcm")]]);
  });

  it("never opens a real transcription provider for an archive-only session", () => {
    const providers: FakeTranscriptionProvider[] = [];
    const { capture } = fakeCapture();
    const store = new SessionStore({
      createProvider: () => {
        const p = new FakeTranscriptionProvider();
        providers.push(p);
        return p;
      },
      trainingCapture: capture,
    });
    store.feedArchive("u1", "s1", Buffer.from("pcm"));
    expect(providers).toHaveLength(0);
  });

  it("calls archiveFinalize on stop, and never touches the live transcript for an archive-only session", async () => {
    const { capture, archiveFinalizeCalls } = fakeCapture();
    const appended: string[] = [];
    const finalized: string[] = [];
    const transcripts = {
      append: (_u: string, _i: string, t: string) => appended.push(t),
      finalize: (_u: string, id: string) => finalized.push(id),
      reopen: () => {},
      finalizeAll: () => {},
      activeName: () => undefined,
    } as any;
    const store = new SessionStore({
      createProvider: () => new FakeTranscriptionProvider(),
      trainingCapture: capture,
      transcripts,
    });
    store.feedArchive("u1", "s1", Buffer.from("pcm"));
    await store.stop("u1", "s1");
    expect(archiveFinalizeCalls).toEqual([["u1", "s1"]]);
    // A session created only via feedArchive is caption-only underneath —
    // no audio was ever fed to a real provider, so nothing was ever
    // appended. `TrainingCapture.finalize`/`TranscriptStore.finalize` are
    // still asked (this is not an ephemeral session), but the real
    // `TranscriptStore` has nothing on record and creates no file — proven
    // end-to-end in server.audioArchive.test.ts.
    expect(appended).toEqual([]);
    expect(finalized).toEqual(["s1"]);
  });

  it("calls archiveFinalize on reapIdle and closeAll too", async () => {
    let t = 0;
    const { capture, archiveFinalizeCalls } = fakeCapture();
    const store = new SessionStore({
      createProvider: () => new FakeTranscriptionProvider(),
      trainingCapture: capture,
      idleTimeoutMs: 100,
      now: () => t,
    });
    store.feedArchive("u1", "s1", Buffer.from("pcm"));
    t = 1000;
    await store.reapIdle();
    expect(archiveFinalizeCalls).toEqual([["u1", "s1"]]);

    store.feedArchive("u1", "s2", Buffer.from("pcm"));
    await store.closeAll();
    expect(archiveFinalizeCalls).toEqual([
      ["u1", "s1"],
      ["u1", "s2"],
    ]);
  });

  it("archives nothing once a session is known to be ephemeral", () => {
    const { capture, archiveAudioCalls } = fakeCapture();
    const store = new SessionStore({
      createProvider: () => new FakeTranscriptionProvider(),
      trainingCapture: capture,
    });
    store.feed("u1", "s1", Buffer.alloc(0), true); // creates it ephemeral
    store.feedArchive("u1", "s1", Buffer.from("pcm"));
    expect(archiveAudioCalls).toEqual([]);
  });

  it("archiving coexists with a caption-only session sharing the same id — captions still reach the live transcript, archived audio still reaches training capture", async () => {
    const { capture, archiveAudioCalls, archiveFinalizeCalls } = fakeCapture();
    const appended: string[] = [];
    const finalized: string[] = [];
    const transcripts = {
      append: (_u: string, _i: string, t: string) => appended.push(t),
      finalize: (_u: string, id: string) => finalized.push(id),
      reopen: () => {},
      finalizeAll: () => {},
      activeName: () => undefined,
    } as any;
    const store = new SessionStore({
      createProvider: () => new FakeTranscriptionProvider(),
      trainingCapture: capture,
      transcripts,
    });
    store.injectCaptions("u1", "s1", [{ text: "kept caption.", isFinal: true }]);
    store.feedArchive("u1", "s1", Buffer.from("pcm"));
    await store.stop("u1", "s1");

    expect(appended).toEqual(["kept caption."]);
    expect(finalized).toEqual(["s1"]);
    expect(archiveAudioCalls).toEqual([["u1", "s1", Buffer.from("pcm")]]);
    expect(archiveFinalizeCalls).toEqual([["u1", "s1"]]);
  });

  it("ignores empty archive bodies but still creates/refreshes the session", () => {
    const { capture, archiveAudioCalls } = fakeCapture();
    const store = new SessionStore({
      createProvider: () => new FakeTranscriptionProvider(),
      trainingCapture: capture,
    });
    store.feedArchive("u1", "s1", Buffer.alloc(0));
    expect(store.has("u1", "s1")).toBe(true);
    expect(archiveAudioCalls).toEqual([]);
  });

  it("does nothing when training capture isn't configured", () => {
    const store = new SessionStore({ createProvider: () => new FakeTranscriptionProvider() });
    expect(() => store.feedArchive("u1", "s1", Buffer.from("pcm"))).not.toThrow();
  });
});

// The finalize race this feature fixes: a provider (in production, the
// Apple sidecar over its finish/done handshake) can still be about to emit
// its true final transcript when `stop`/`reapIdle` are asked to end a
// session. `FakeTranscriptionProvider.closeBarrier` stands in for that
// window — a `close()` that does not resolve until the test says so — so
// these prove `SessionStore` actually waits for it before finalizing,
// rather than merely happening to pass because a fake provider resolves
// synchronously.
describe("SessionStore finalize race", () => {
  it("stop does not finalize until the provider's close() resolves, so a final that arrives during the wait is not orphaned", async () => {
    const { store, providers, appended, finalized } = makeStore();
    store.feed("u1", "s1", Buffer.alloc(0));

    let resolveClose!: () => void;
    providers[0]!.closeBarrier = new Promise((r) => {
      resolveClose = r;
    });

    let stopped = false;
    const stopPromise = store.stop("u1", "s1").then(() => {
      stopped = true;
    });

    // Let stop()'s microtasks run up to the point where it's blocked on
    // provider.close(). If the fix regressed to firing close() and
    // finalizing right away (the old, Deepgram-era assumption), this would
    // already be true here.
    await Promise.resolve();
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(finalized).toEqual([]);
    expect(appended).toEqual([]);

    // The true final arrives in the finish/done window, same as it does for
    // the real Apple provider — then the handshake completes.
    providers[0]!.emitTranscript({ text: "true final", isFinal: true });
    resolveClose();
    await stopPromise;

    expect(stopped).toBe(true);
    expect(appended).toEqual(["true final"]);
    expect(finalized).toEqual(["s1"]);
  });

  it("reapIdle has the same guarantee as stop", async () => {
    let t = 0;
    const { store, providers, appended, finalized } = makeStore({
      idleTimeoutMs: 100,
      now: () => t,
    });
    store.feed("u1", "s1", Buffer.alloc(0));
    t = 1000;

    let resolveClose!: () => void;
    providers[0]!.closeBarrier = new Promise((r) => {
      resolveClose = r;
    });

    let reaped = false;
    const reapPromise = store.reapIdle().then(() => {
      reaped = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(reaped).toBe(false);
    expect(finalized).toEqual([]);

    providers[0]!.emitTranscript({ text: "late final", isFinal: true });
    resolveClose();
    await reapPromise;

    expect(reaped).toBe(true);
    expect(appended).toEqual(["late final"]);
    expect(finalized).toEqual(["s1"]);
  });

  it("a hung provider (close() never resolving on its own) still lets stop() complete once the provider's own bound resolves it", async () => {
    // SessionStore itself imposes no timeout — the bound is the provider's
    // own responsibility (AppleTranscriptionProvider.FINISH_TIMEOUT_MS).
    // This proves SessionStore does not hang forever *waiting on nothing*
    // — once the provider resolves close() for any reason, stop() finishes.
    vi.useFakeTimers();
    try {
      const { store, providers, finalized } = makeStore();
      store.feed("u1", "s1", Buffer.alloc(0));
      let resolveClose!: () => void;
      providers[0]!.closeBarrier = new Promise((r) => {
        resolveClose = r;
      });
      let stopped = false;
      const stopPromise = store.stop("u1", "s1").then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(20_000); // long past any real bound
      expect(stopped).toBe(false); // still not resolved — nothing has told it to be
      resolveClose(); // simulates the provider's own bound finally firing
      await stopPromise;
      expect(stopped).toBe(true);
      expect(finalized).toEqual(["s1"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
