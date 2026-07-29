# Live Caption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Live caption" button to the watch that streams captions to the screen while the relay keeps nothing — no transcript file, no summary, no Notion export.

**Architecture:** The watch does not persist transcripts; the relay does. So the watch declares intent with `&ephemeral=1` on its `/v1/audio` posts, and `SessionStore` records that on the session at creation time and skips every `TranscriptStore` call for it. On the watch, a `SessionMode` enum replaces the `resuming: String?` parameter threaded through `Relay` and `SessionController`, which makes "live and resuming" — a state that cannot exist — unrepresentable.

**Tech Stack:** TypeScript + Node (relay, tested with vitest), Swift 5.9 + SwiftUI + XCTest (watch app and `CaptionCore`), XcodeGen.

Spec: `docs/superpowers/specs/2026-07-29-watch-live-caption-design.md`

## Global Constraints

- watchOS deployment target is **10.0**. Every SF Symbol and API used must exist there.
- The relay's saved-session behavior must not change. Existing backend tests pass untouched, except where a test's own helper signature changes.
- The ephemeral flag is **sticky at session creation**. No later request may turn a live session into a saved one or the reverse.
- `CaptionCore` is a SwiftPM package consumed by **both** `watch/` and `mac/`. Any change to a public protocol in it must keep the mac target compiling.
- The `WatchCaptions` app target has **no test target** — only `CaptionCore` has tests. Changes in `watch/WatchCaptions/` are verified by a build plus a run, not by unit tests.
- Icons: `New session` uses `record.circle`, `Live caption` uses `waveform`.
- Copy: the menu row reads exactly `New session` and the live button's accessibility label is exactly `Live caption`.

---

## File Structure

**Backend**
- `backend/src/sessionStore.ts` — modify. Owns the per-session `ephemeral` bit and skips `append`/`finalize` for it.
- `backend/src/sessionStore.test.ts` — modify. Extend `makeStore` with a transcripts spy; add ephemeral cases.
- `backend/src/server.ts` — modify (`/v1/audio` handler, ~lines 203–228). Parses the query flag, passes it to `feed`, suppresses `reopen`, omits `transcript`.
- `backend/src/server.http.test.ts` — modify. End-to-end ephemeral cases.
- `backend/README.md` — modify. Document the flag.

**CaptionCore (shared)**
- `watch/CaptionCore/Sources/CaptionCore/SessionMode.swift` — **create**. The enum, alone in its own file: it is the vocabulary both the transport and the controller speak.
- `watch/CaptionCore/Sources/CaptionCore/Protocols.swift` — modify. `Relay.connect(mode:)`.
- `watch/CaptionCore/Sources/CaptionCore/SessionController.swift` — modify. `start(mode:)`.
- `watch/CaptionCore/Tests/CaptionCoreTests/SessionControllerTests.swift` — modify. `FakeRelay` records the mode; live-mode cases.

**Mac (conformance only)**
- `mac/MacCaptions/WebSocketRelay.swift:52` — modify. Signature only.
- `mac/MacCaptions/LocalSpeechRelay.swift:22` — modify. Signature only.

**Watch app**
- `watch/WatchCaptions/HTTPRelayClient.swift` — modify. Derives `resumeName` and the `ephemeral` query item from the mode.
- `watch/WatchCaptions/AppModel.swift` — modify. `startLive()`, a published `live` flag, mode-preserving `retry()`.
- `watch/WatchCaptions/Views/HomeView.swift` — modify. Split first row.
- `watch/WatchCaptions/Views/CaptionView.swift` — modify. Hollow-ring indicator.
- `watch/WatchCaptions/WatchCaptionsApp.swift` — modify. Wires `onLive`, `isLive`, and `retry`.
- `watch/README.md` — modify. Document the feature.

---

## Task 1: Relay keeps nothing for an ephemeral session

**Files:**
- Modify: `backend/src/sessionStore.ts`
- Test: `backend/src/sessionStore.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `SessionStore.feed(id: string, pcm: Buffer, ephemeral?: boolean): void` — third parameter defaults to `false` and is honoured **only** when the session is created.
  - `SessionStore.isEphemeral(id: string): boolean` — `false` for unknown sessions.

Work in `backend/`. All commands below assume that directory.

- [ ] **Step 1: Extend the test helper with a transcripts spy**

`makeStore` currently passes no `transcripts`. Replace it at the top of `src/sessionStore.test.ts`:

```ts
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
```

Existing tests destructure only `store` and `providers`, so they keep working.

- [ ] **Step 2: Write the failing tests**

Append this `describe` block to the end of `src/sessionStore.test.ts`:

```ts
describe("SessionStore ephemeral sessions", () => {
  it("appends nothing and finalizes nothing for an ephemeral session", () => {
    const { store, providers, appended, finalized } = makeStore();
    store.feed("s1", Buffer.alloc(0), true);
    providers[0].emitTranscript({ text: "off the record", isFinal: true });
    store.stop("s1");
    expect(appended).toEqual([]);
    expect(finalized).toEqual([]);
  });

  it("still persists a normal session", () => {
    const { store, providers, appended, finalized } = makeStore();
    store.feed("s1", Buffer.alloc(0));
    providers[0].emitTranscript({ text: "on the record", isFinal: true });
    store.stop("s1");
    expect(appended).toEqual(["on the record"]);
    expect(finalized).toEqual(["s1"]);
  });

  it("stays ephemeral when a later feed omits the flag", () => {
    const { store, providers, appended, finalized } = makeStore();
    store.feed("s1", Buffer.alloc(0), true);
    store.feed("s1", Buffer.from("more audio"));   // flag absent
    providers[0].emitTranscript({ text: "still off", isFinal: true });
    store.stop("s1");
    expect(appended).toEqual([]);
    expect(finalized).toEqual([]);
  });

  it("stays saved when a later feed sets the flag", () => {
    const { store, providers, appended } = makeStore();
    store.feed("s1", Buffer.alloc(0));
    store.feed("s1", Buffer.from("more audio"), true);   // must not take effect
    providers[0].emitTranscript({ text: "on the record", isFinal: true });
    expect(appended).toEqual(["on the record"]);
  });

  it("does not finalize an ephemeral session that is reaped for idleness", () => {
    let clock = 0;
    const { store, providers, finalized } = makeStore({
      idleTimeoutMs: 100,
      now: () => clock,
    });
    store.feed("s1", Buffer.alloc(0), true);
    providers[0].emitTranscript({ text: "off the record", isFinal: true });
    clock = 1000;
    store.reapIdle();
    expect(store.has("s1")).toBe(false);
    expect(finalized).toEqual([]);
  });

  it("does not finalize an ephemeral session on closeAll", () => {
    const { store, providers, finalized } = makeStore();
    store.feed("s1", Buffer.alloc(0), true);
    store.feed("s2", Buffer.alloc(0));
    providers[0].emitTranscript({ text: "off", isFinal: true });
    providers[1].emitTranscript({ text: "on", isFinal: true });
    store.closeAll();
    expect(finalized).toEqual(["s2"]);
  });

  it("reports whether a session is ephemeral", () => {
    const { store } = makeStore();
    store.feed("live", Buffer.alloc(0), true);
    store.feed("saved", Buffer.alloc(0));
    expect(store.isEphemeral("live")).toBe(true);
    expect(store.isEphemeral("saved")).toBe(false);
    expect(store.isEphemeral("unknown")).toBe(false);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -- src/sessionStore.test.ts`

Expected: the ephemeral cases FAIL — `feed` takes two parameters so the flag is ignored, captions are appended, and `isEphemeral` does not exist (TypeScript error `Property 'isEphemeral' does not exist`). "still persists a normal session" should PASS already.

- [ ] **Step 4: Add the `ephemeral` bit to the session record**

In `src/sessionStore.ts`, extend the `Session` interface:

```ts
interface Session {
  caption: CaptionSession;
  events: SeqEvent[];
  seq: number;
  lastActivity: number;
  /**
   * Live-only: the relay keeps no transcript for this session. Fixed when the
   * session is created, so no later request can change what a conversation
   * already in progress does with what it hears.
   */
  ephemeral: boolean;
}
```

- [ ] **Step 5: Thread the flag through `feed` and `getOrCreate`**

Replace `feed`:

```ts
  /**
   * Feed audio (may be empty) for a session, lazily creating it on first use.
   * `ephemeral` is honoured only on creation — see `Session.ephemeral`.
   */
  feed(id: string, pcm: Buffer, ephemeral = false): void {
    const session = this.getOrCreate(id, ephemeral);
    session.lastActivity = this.now();
    if (pcm.length > 0) session.caption.handleAudio(pcm);
  }
```

Replace the `getOrCreate` signature and body, guarding the append:

```ts
  private getOrCreate(id: string, ephemeral: boolean): Session {
    const existing = this.sessions.get(id);
    if (existing) return existing;

    const provider = this.createProvider();
    const session: Session = {
      caption: undefined as unknown as CaptionSession,
      events: [],
      seq: 0,
      lastActivity: this.now(),
      ephemeral,
    };
    // CaptionSession registers provider handlers in its constructor; its outbound
    // messages are buffered here with sequence numbers.
    session.caption = new CaptionSession(provider, (payload: OutboundMessage) => {
      session.seq += 1;
      session.events.push({ seq: session.seq, payload });
      // Skipping `append` is what keeps a live session off disk entirely:
      // `append` is also what creates the file.
      if (payload.type === "caption" && payload.isFinal && !session.ephemeral) {
        this.transcripts?.append(id, payload.text, payload.channel);
      }
    });
    this.sessions.set(id, session);
    return session;
  }
```

- [ ] **Step 6: Guard the three teardown paths and expose the bit**

Still in `src/sessionStore.ts`. In `stop`:

```ts
  /** Close and remove a session. */
  stop(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.caption.close();
    this.sessions.delete(id);
    if (!session.ephemeral) this.transcripts?.finalize(id);
  }
```

In `reapIdle`:

```ts
      if (session.lastActivity < cutoff) {
        session.caption.close();
        this.sessions.delete(id);
        if (!session.ephemeral) this.transcripts?.finalize(id);
      }
```

In `closeAll`:

```ts
    for (const [id, session] of this.sessions) {
      session.caption.close();
      if (!session.ephemeral) this.transcripts?.finalize(id);
    }
```

Then add this public method, next to `has`:

```ts
  /**
   * True when this session was created live-only. False for a session this
   * store has never seen, so a caller can trust it over its own query string.
   */
  isEphemeral(id: string): boolean {
    return this.sessions.get(id)?.ephemeral ?? false;
  }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test -- src/sessionStore.test.ts`
Expected: PASS, all cases.

Then the whole suite and the typecheck:

Run: `npm test && npm run build`
Expected: PASS, no TypeScript errors.

- [ ] **Step 8: Commit**

```bash
git add backend/src/sessionStore.ts backend/src/sessionStore.test.ts
git commit -m "feat(relay): let a session opt out of being written down"
```

---

## Task 2: `/v1/audio?ephemeral=1`

**Files:**
- Modify: `backend/src/server.ts` (the `/v1/audio` branch, ~lines 203–228)
- Modify: `backend/README.md`
- Test: `backend/src/server.http.test.ts`

**Interfaces:**
- Consumes: `SessionStore.feed(id, pcm, ephemeral?)` and `SessionStore.isEphemeral(id)` from Task 1.
- Produces: the wire contract the watch depends on in Task 4 — `POST /v1/audio?session=…&token=…&ephemeral=1` persists nothing, ignores any `resume=` param, and returns a body with **no** `transcript` key.

Work in `backend/`.

- [ ] **Step 1: Write the failing tests**

Append to `src/server.http.test.ts`. The `startServer` call mirrors the existing `resume` test's fake `transcripts` object:

```ts
describe("ephemeral sessions", () => {
  function startWithTranscriptSpy(authToken: string) {
    const appended: string[] = [];
    const finalized: string[] = [];
    const reopened: Array<[string, string]> = [];
    const server = startServer({
      port: 0,
      authToken,
      createProvider: () => new FakeTranscriptionProvider(),
      transcripts: {
        append: (_id: string, text: string) => appended.push(text),
        finalize: (id: string) => finalized.push(id),
        reopen: (id: string, name: string) => reopened.push([id, name]),
        finalizeAll: () => {},
        activeName: () => "2026-07-29T10-00-00Z_s1",
      } as any,
    });
    running = server;
    const port = (server.address() as AddressInfo).port;
    return { port, appended, finalized, reopened };
  }

  it("omits the transcript name for a live session", async () => {
    const { port } = startWithTranscriptSpy("t");
    const res = await fetch(
      `http://127.0.0.1:${port}/v1/audio?session=s1&token=t&ephemeral=1`,
      { method: "POST", body: new Uint8Array(0) },
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).not.toHaveProperty("transcript");
  });

  it("still names the transcript for a saved session", async () => {
    const { port } = startWithTranscriptSpy("t");
    const res = await fetch(
      `http://127.0.0.1:${port}/v1/audio?session=s1&token=t`,
      { method: "POST", body: new Uint8Array(0) },
    );
    const body = await res.json();
    expect(body.transcript).toBe("2026-07-29T10-00-00Z_s1");
  });

  it("ignores resume= for a live session", async () => {
    const { port, reopened } = startWithTranscriptSpy("t");
    await fetch(
      `http://127.0.0.1:${port}/v1/audio?session=s1&token=t&ephemeral=1&resume=2026-07-06T01-02-03Z_abc`,
      { method: "POST", body: new Uint8Array(0) },
    );
    expect(reopened).toEqual([]);
  });

  it("keeps a live session live across posts and on stop", async () => {
    const { port, appended, finalized } = startWithTranscriptSpy("t");
    await fetch(`http://127.0.0.1:${port}/v1/audio?session=s1&token=t&ephemeral=1`, {
      method: "POST",
      body: new Uint8Array(0),
    });
    // A second post without the flag must not start saving.
    const res = await fetch(`http://127.0.0.1:${port}/v1/audio?session=s1&token=t`, {
      method: "POST",
      body: new Uint8Array(0),
    });
    expect(await res.json()).not.toHaveProperty("transcript");
    await fetch(`http://127.0.0.1:${port}/v1/stop?session=s1&token=t`, {
      method: "POST",
    });
    expect(appended).toEqual([]);
    expect(finalized).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- src/server.http.test.ts`

Expected: "omits the transcript name for a live session", "ignores resume=", and "keeps a live session live" FAIL — the server ignores `ephemeral`, so it returns `transcript` and calls `reopen`. The "still names" case should PASS already.

- [ ] **Step 3: Read the flag and suppress `reopen`**

In `src/server.ts`, inside `if (url.pathname === "/v1/audio") {`, replace the resume block:

```ts
      // Live sessions are never written down, so there is nothing to resume
      // into and nothing to bind. Read before the session exists, because
      // `reopen` has to happen at creation time.
      const ephemeral = url.searchParams.get("ephemeral") === "1";
      // A resumed session appends to an existing transcript instead of opening
      // a new one. Only meaningful before the session exists; later posts for
      // the same session carry the param but must not re-bind it.
      const resume = url.searchParams.get("resume");
      if (resume && !ephemeral && !store.has(session)) {
        opts.transcripts?.reopen(session, resume);
      }
```

- [ ] **Step 4: Pass the flag to `feed` and omit `transcript`**

A little further down in the same branch, replace the `feed`/`drain`/`sendJSON` sequence:

```ts
      store.feed(session, body, ephemeral);
      const { events, seq } = store.drain(session, since);
      sendJSON(res, 200, {
        events: flatten(events),
        seq,
        // Names the transcript this session is writing to, so the client can
        // resume it later. Absent until the first caption creates the file —
        // and always absent for a live session, which creates none. Asking the
        // store rather than the query string keeps the answer stable for the
        // whole session, even if a later post drops the flag.
        transcript: store.isEphemeral(session)
          ? undefined
          : opts.transcripts?.activeName(session),
      });
      return;
```

`JSON.stringify` drops `undefined` values, so the key is genuinely absent rather than null.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- src/server.http.test.ts`
Expected: PASS.

Run: `npm test && npm run build`
Expected: PASS, no TypeScript errors. Pay attention to `src/server.transcripts.test.ts` and `src/server.test.ts` — they cover the saved path and must be untouched.

- [ ] **Step 6: Document the flag**

`backend/README.md` documents this endpoint in prose sections, not a table. Add a new section immediately after the `### Resuming a session` section (which ends with the line about sessions being finalized after 10 minutes), in the same voice:

```markdown
### Live sessions

`POST /v1/audio?session=<id>&ephemeral=1` streams captions back as usual but
persists nothing: no transcript file, so no summary and no Notion page. The
response carries no `transcript` name, because there is none to resume into, and
`resume=` is ignored.

The flag is fixed when the session is created. A later post that drops it does
not start saving, and one that adds it does not stop — a conversation cannot
change what it does with what it hears half way through.
```

- [ ] **Step 7: Verify the docs match the code**

Re-read the section you just wrote against `src/server.ts`. Every claim in it — no `transcript` key, `resume=` ignored, flag fixed at creation — is covered by a test you wrote in Step 1. If any sentence is not, either delete the sentence or add the test.

- [ ] **Step 8: Commit**

```bash
git add backend/src/server.ts backend/src/server.http.test.ts backend/README.md
git commit -m "feat(relay): accept ephemeral=1 on /v1/audio"
```

---

## Task 3: `SessionMode` in CaptionCore

**Files:**
- Create: `watch/CaptionCore/Sources/CaptionCore/SessionMode.swift`
- Modify: `watch/CaptionCore/Sources/CaptionCore/Protocols.swift:7-8`
- Modify: `watch/CaptionCore/Sources/CaptionCore/SessionController.swift:37-58`, `105-113`
- Modify: `mac/MacCaptions/WebSocketRelay.swift:50-52`
- Modify: `mac/MacCaptions/LocalSpeechRelay.swift:22`
- Test: `watch/CaptionCore/Tests/CaptionCoreTests/SessionControllerTests.swift`

**Interfaces:**
- Consumes: nothing from earlier tasks. (Task 1 and 2 are the relay; this is the client.)
- Produces:
  - `public enum SessionMode: Equatable, Sendable { case saved(resuming: String?); case live }`
  - `Relay.connect(mode: SessionMode)` replacing `connect(resuming: String?)`
  - `SessionController.start(mode: SessionMode = .saved(resuming: nil)) async`

`CaptionCore` uses XCTest, not swift-testing — follow the existing file.

- [ ] **Step 1: Write the failing tests**

Two edits to `watch/CaptionCore/Tests/CaptionCoreTests/SessionControllerTests.swift`.

First, replace `FakeRelay`'s connect tracking (lines 11–15) so it records the mode:

```swift
        var connectCount = 0
        /// The mode the last `connect` was handed, or nil if never connected.
        var mode: SessionMode?
        var closed = false
        var sent: [Data] = []
        func connect(mode: SessionMode) { connected = true; connectCount += 1; self.mode = mode }
```

Note `resumedName` is gone — Step 4 updates the assertions that used it.

Second, append these cases inside the `SessionControllerTests` class:

```swift
    func testLiveModeReachesTheRelay() async {
        let relay = FakeRelay()
        let c = SessionController(store: CaptionStore(), relay: relay,
                                  audio: FakeAudio(), permission: FakePermission(granted: true))
        await c.start(mode: .live)
        XCTAssertEqual(relay.mode, .live)
    }

    func testLiveModeRestoresNoTranscript() async {
        let relay = FakeRelay()
        let store = CaptionStore()
        let history = FakeHistory(segments: [
            TranscriptSegment(text: "earlier talk", channel: nil, at: "2026-07-10T18:00:00Z")
        ])
        let c = SessionController(store: store, relay: relay,
                                  audio: FakeAudio(), permission: FakePermission(granted: true),
                                  history: history)
        await c.start(mode: .live)
        await c.waitForPrefill()
        XCTAssertTrue(store.paragraphs.isEmpty)
    }

    func testLiveModeStillCapturesAudio() async {
        let relay = FakeRelay()
        let audio = FakeAudio()
        let c = SessionController(store: CaptionStore(), relay: relay,
                                  audio: audio, permission: FakePermission(granted: true))
        await c.start(mode: .live)
        relay.deliver(.ready)
        XCTAssertTrue(audio.started)
    }
```

That `TranscriptSegment(text:channel:at:)` call matches the initializer in `History.swift:34` and the way line ~241 of this same test file already builds one.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `swift test --package-path watch/CaptionCore`

Expected: FAIL to compile — `connect(mode:)` does not satisfy `Relay`, and `start(mode:)` does not exist.

- [ ] **Step 3: Create the enum**

Create `watch/CaptionCore/Sources/CaptionCore/SessionMode.swift`:

```swift
/// What a session does with what it hears.
///
/// A live session has no transcript to append to, so `.live` carries no name.
/// That is the point of the enum over a `Bool` beside `resuming:` — it makes
/// "live and resuming" a state the type system rules out rather than one a
/// guard has to remember to reject.
public enum SessionMode: Equatable, Sendable {
    /// The relay persists captions. `resuming` names an existing transcript to
    /// append to; nil opens a new one.
    case saved(resuming: String?)
    /// Captions reach the screen and nowhere else: the relay writes no file,
    /// runs no summary, and exports nothing.
    case live
}
```

- [ ] **Step 4: Change the protocol and the controller**

In `Protocols.swift`, replace the `connect` declaration and its doc comment:

```swift
    /// `mode` decides what the relay does with this session's captions —
    /// whether it persists them, and which transcript it appends to.
    func connect(mode: SessionMode)
```

In `SessionController.swift`, replace `start` (lines 37–58). Only the signature, the `relay.connect` call, and the restore condition change:

```swift
    /// Begin a session. Safe to call repeatedly; no-op if already running.
    /// `.saved(resuming:)` appends to an existing transcript instead of opening
    /// a new one — what the app does when you glance back mid-conversation.
    /// `.live` keeps nothing, so it never restores anything either.
    public func start(mode: SessionMode = .saved(resuming: nil)) async {
        guard !running else { return }
        running = true
        generation += 1
        let generation = self.generation
        store.reset()
        supersededPrefillTask = prefillTask
        prefillTask = nil
        guard await permission.ensureGranted() else {
            store.setError("Microphone access is off. Enable it in Settings › Privacy.")
            running = false
            return
        }
        // `running` alone can't tell this session apart from a stop+start that
        // reused the flag while we were suspended; compare generation too.
        guard running, self.generation == generation else { return }
        relay.connect(mode: mode)
        // Only a resumed saved session has scrollback to put back. The pattern
        // match is why `.live` needs no guard of its own.
        if case .saved(let name?) = mode { restorePreviousTranscript(named: name) }
    }
```

- [ ] **Step 5: Update the existing test call sites**

In `SessionControllerTests.swift`, the bare `await c.start()` and `await controller.start()` calls need no change — the default parameter covers them. Update every call that passes a name, and the three assertions that used `resumedName`:

- `await controller.start(resuming: "X")` → `await controller.start(mode: .saved(resuming: "X"))` (lines ~229, 247, 256 area, 268, 280, 290, 307, 309, and the two inside `Task { }` at ~333 and ~337)
- `XCTAssertEqual(relay.resumedName, "2026-07-25T09-00-00Z_abc")` → `XCTAssertEqual(relay.mode, .saved(resuming: "2026-07-25T09-00-00Z_abc"))`
- `XCTAssertEqual(relay.resumedName, String?.none)` → `XCTAssertEqual(relay.mode, .saved(resuming: nil))`
- `XCTAssertEqual(relay.resumedName, "2026-07-10T18-00-00Z_abc")` → `XCTAssertEqual(relay.mode, .saved(resuming: "2026-07-10T18-00-00Z_abc"))`
- `XCTAssertEqual(relay.resumedName, "current")` → `XCTAssertEqual(relay.mode, .saved(resuming: "current"))`

Let the compiler find any you missed; do not add a `resumedName` shim to avoid the edits.

- [ ] **Step 6: Keep the mac app compiling**

`CaptionCore` is shared, and both mac relays conform to `Relay`. Neither uses the parameter, so this is a signature change only.

`mac/MacCaptions/WebSocketRelay.swift`, replacing lines 50–52:

```swift
    // Mac sessions always start fresh, the relay names the transcript itself,
    // and there is no live-only mode here — so the mode carries nothing this
    // transport can act on.
    func connect(mode _: SessionMode) {
```

`mac/MacCaptions/LocalSpeechRelay.swift` line 22:

```swift
    func connect(mode _: SessionMode) {
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `swift test --package-path watch/CaptionCore`
Expected: PASS, all cases including the three new ones.

- [ ] **Step 8: Commit**

```bash
git add watch/CaptionCore mac/MacCaptions/WebSocketRelay.swift mac/MacCaptions/LocalSpeechRelay.swift
git commit -m "feat(core): give a session a mode instead of a resume name"
```

---

## Task 4: The watch asks for a live session

**Files:**
- Modify: `watch/WatchCaptions/HTTPRelayClient.swift:12`, `40-58`, `113-125`

**Interfaces:**
- Consumes: `SessionMode` and `Relay.connect(mode:)` from Task 3; the `ephemeral=1` wire contract from Task 2.
- Produces: `HTTPRelayClient` conforming to the new protocol. `onTranscript` never fires for a live session, because the relay sends no name.

There is no test target for the `WatchCaptions` app, so this task is verified by a build. Its behavior is covered end-to-end by Task 2's server tests and by the manual pass in Task 6.

- [ ] **Step 1: Store the mode's two consequences**

In `watch/WatchCaptions/HTTPRelayClient.swift`, add a stored property next to `resumeName` (near line 20):

```swift
    private var resumeName: String?
    /// Live-only session: ask the relay to keep nothing. Set per connect, and
    /// sent on every request so a session the relay reaped and recreated comes
    /// back live rather than silently starting to save.
    private var ephemeral = false
```

Also update the `onTranscript` doc comment (line 10–12) to say it never fires for a live session:

```swift
    /// Fires once with the transcript this session is writing to, so the app
    /// can offer to resume it later. The relay assigns the name — and sends
    /// none for a live session, so this never fires for one.
    var onTranscript: (@MainActor (String) -> Void)?
```

- [ ] **Step 2: Derive both from the mode in `connect`**

Replace the `connect` signature and the two lines that set up resume state:

```swift
    func connect(mode: SessionMode) {
        queue.async { [weak self] in
            guard let self else { return }
            // Start a fresh session each connect so reconnects (Try Again, returning
            // to the foreground, a network change) don't reuse stale state. When
            // resuming, the relay binds that new session to an existing transcript.
            self.timer?.cancel()
            self.sessionID = UUID().uuidString
            switch mode {
            case .saved(let name):
                self.resumeName = name
                self.ephemeral = false
            case .live:
                self.resumeName = nil
                self.ephemeral = true
            }
            self.transcriptDelivered = false
            self.pending = Data()
            self.lastSeq = 0
            self.readyDelivered = false
            self.inFlight = false
            self.stopped = false
            self.startTimer()
            self.flush()   // immediate first POST establishes the session
        }
    }
```

- [ ] **Step 3: Send the flag**

In `url(path:since:)`, add the query item after the `resumeName` line:

```swift
        if let resumeName { items.append(URLQueryItem(name: "resume", value: resumeName)) }
        if ephemeral { items.append(URLQueryItem(name: "ephemeral", value: "1")) }
```

- [ ] **Step 4: Build to verify it compiles**

Run: `cd watch && xcodegen generate && xcodebuild -project WatchCaptions.xcodeproj -scheme WatchCaptions -destination 'platform=watchOS Simulator,name=Apple Watch Series 10 (46mm)' build`

Expected: BUILD SUCCEEDED. If that simulator name does not exist, run `xcrun simctl list devices available | grep Watch` and substitute one that does. `AppModel` still calls `controller.start(resuming:)` at this point, which no longer exists — if the build fails only on those call sites in `AppModel.swift`, that is expected and Task 5 fixes it; confirm `HTTPRelayClient.swift` itself reports no errors before moving on.

- [ ] **Step 5: Commit**

```bash
git add watch/WatchCaptions/HTTPRelayClient.swift
git commit -m "feat(watch): ask the relay to keep nothing for a live session"
```

---

## Task 5: Live mode in AppModel

**Files:**
- Modify: `watch/WatchCaptions/AppModel.swift:22-31`, `88-146`

**Interfaces:**
- Consumes: `SessionMode`, `SessionController.start(mode:)` from Task 3; `HTTPRelayClient` from Task 4.
- Produces, for Task 6 to wire up:
  - `AppModel.live: Bool` — published, `private(set)`. True while a live session is on screen.
  - `AppModel.startLive() async`
  - `AppModel.retry() async` — restarts in whichever mode the failed session was.

- [ ] **Step 1: Publish the live flag**

In `watch/WatchCaptions/AppModel.swift`, add below `capturing` (line 16–17):

```swift
    /// True while a session is capturing, which takes over the whole screen.
    @Published private(set) var capturing = false
    /// True when the session on screen is live-only. Drives the captions
    /// screen's indicator, and keeps the session out of "Continue last".
    @Published private(set) var live = false
```

- [ ] **Step 2: Add `startLive` and route the existing starts through the mode**

Replace the session-starting block (lines 88–108):

```swift
    func startNew() async {
        currentTranscript = nil
        await startCaptions(mode: .saved(resuming: nil))
    }

    /// Caption without keeping anything: the relay writes no transcript, so
    /// there is nothing to resume, browse, or delete afterwards.
    func startLive() async {
        currentTranscript = nil
        await startCaptions(mode: .live)
    }

    func continueLast() async {
        guard let name = lastSession?.transcriptName else { return }
        await startCaptions(mode: .saved(resuming: name))
    }

    func resume(name: String) async {
        await startCaptions(mode: .saved(resuming: name))
    }

    /// Restart after a connection error, in the mode that failed. Retrying a
    /// live session must not quietly start recording one.
    func retry() async {
        if live {
            await startLive()
        } else {
            await startNew()
        }
    }

    private func startCaptions(mode: SessionMode) async {
        stoppedExplicitly = false
        if case .saved(let name) = mode {
            currentTranscript = name
            live = false
        } else {
            currentTranscript = nil
            live = true
        }
        path = [.captions]   // pushed, so it gets a back chevron like any screen
        capturing = true
        await controller.start(mode: mode)
    }
```

- [ ] **Step 3: Make leaving a live session end it**

Replace `endCapture` and `rememberCurrentSession` (lines 126–146). A live session is never offered under "Continue last", and leaving one must not drop you back into an *older* saved session on relaunch:

```swift
    private func endCapture() {
        controller.stop()
        rememberCurrentSession()
        capturing = false
        live = false
    }

    /// Backgrounding stops capture but keeps the session resumable — the relay
    /// holds the transcript open for ten minutes. A live session is the
    /// exception: there is nothing held open, so it simply ends.
    func pause() {
        guard capturing else { return }
        controller.stop()
        rememberCurrentSession()
    }

    private func rememberCurrentSession() {
        // A live session leaves no transcript, so there is nothing to offer
        // under "Continue last" — and nothing to auto-resume into either.
        // Marking it as deliberately stopped keeps the next launch on the menu
        // rather than reviving whichever saved session preceded it, which would
        // read as the app ignoring the choice you just made.
        if live {
            stoppedExplicitly = true
            return
        }
        guard let name = currentTranscript else { return }
        let session = LastSession(transcriptName: name, endedAt: Date())
        lastSession = session
        defaults.set(name, forKey: Keys.transcriptName)
        defaults.set(session.endedAt.timeIntervalSince1970, forKey: Keys.endedAt)
    }
```

`stop()` already sets `stoppedExplicitly = true` before calling `endCapture()`, so the two paths agree.

- [ ] **Step 4: Build to verify it compiles**

Run: `cd watch && xcodebuild -project WatchCaptions.xcodeproj -scheme WatchCaptions -destination 'platform=watchOS Simulator,name=Apple Watch Series 10 (46mm)' build`

Expected: build fails only in `WatchCaptionsApp.swift` (it still calls `HomeView` without `onLive`, `CaptionView` without `isLive`, and `startNew` for retry). Task 6 fixes those. Confirm `AppModel.swift` reports no errors.

- [ ] **Step 5: Commit**

```bash
git add watch/WatchCaptions/AppModel.swift
git commit -m "feat(watch): add a live session that is never remembered"
```

---

## Task 6: The button, the indicator, and the docs

**Files:**
- Modify: `watch/WatchCaptions/Views/HomeView.swift`
- Modify: `watch/WatchCaptions/Views/CaptionView.swift:29-31`
- Modify: `watch/WatchCaptions/WatchCaptionsApp.swift:40-44`, `70`, `72`
- Modify: `watch/README.md`

**Interfaces:**
- Consumes: `AppModel.live`, `AppModel.startLive()`, `AppModel.retry()` from Task 5.
- Produces: `HomeView(lastSession:onNew:onLive:onContinue:onBrowse:versionLabel:)` and `CaptionView(store:isLive:onStop:)`.

- [ ] **Step 1: Split the first row of the menu**

In `watch/WatchCaptions/Views/HomeView.swift`, add the closure to the property list, after `onNew`:

```swift
    let onNew: () -> Void
    /// Caption without keeping a transcript.
    let onLive: () -> Void
```

Then replace the `Button(action: onNew)` row (lines 15–17) with the split row:

```swift
            // One row, two buttons: the wide one records, the narrow one does
            // not. `.bordered` on both is load-bearing — a bare Button in a
            // watchOS list row expands to the full width, and two of them
            // would fight over it.
            HStack(spacing: 6) {
                Button(action: onNew) {
                    Label("New session", systemImage: "record.circle")
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .frame(maxWidth: .infinity)
                }
                Button(action: onLive) {
                    Image(systemName: "waveform")
                }
                .frame(width: 40)
                .accessibilityLabel("Live caption")
                .accessibilityHint("Captions on screen only. Nothing is saved.")
            }
            .buttonStyle(.bordered)
```

- [ ] **Step 2: Make the indicator say whether anything is being kept**

In `watch/WatchCaptions/Views/CaptionView.swift`, add the property below `store`:

```swift
    @ObservedObject var store: CaptionStore
    /// True when nothing is being written down, which the indicator reflects.
    let isLive: Bool
    let onStop: () -> Void
```

Replace the overlay (lines 29–31):

```swift
        // Filled means this is being recorded; a hollow ring means the captions
        // are all there is. Same spot and size either way — there is no room on
        // this screen for a second piece of chrome.
        .overlay(alignment: .topTrailing) {
            Group {
                if isLive {
                    Circle().strokeBorder(.green, lineWidth: 1.5)
                } else {
                    Circle().fill(.green)
                }
            }
            .frame(width: 7, height: 7)
            // A bare shape is not an accessibility element, so VoiceOver would
            // skip the indicator entirely and a label alone would do nothing.
            .accessibilityElement()
            .accessibilityLabel(isLive ? "Live only, not saved" : "Recording")
        }
```

- [ ] **Step 3: Wire it up**

In `watch/WatchCaptions/WatchCaptionsApp.swift`, add `onLive` to the `HomeView` call (lines 40–44):

```swift
                HomeView(
                    lastSession: model.lastSession,
                    onNew: { Task { await model.startNew() } },
                    onLive: { Task { await model.startLive() } },
                    onContinue: { Task { await model.continueLast() } },
                    onBrowse: { Task { await model.showHistory() } })
```

Then pass the flag through, and make retry preserve the mode (lines 70 and 72):

```swift
        case .listening:
            CaptionView(store: store, isLive: model.live, onStop: { model.stop() })
        case .error(let message):
            ErrorView(message: message, onRetry: { Task { await model.retry() } })
```

- [ ] **Step 4: Build and run**

Run: `cd watch && xcodegen generate && xcodebuild -project WatchCaptions.xcodeproj -scheme WatchCaptions -destination 'platform=watchOS Simulator,name=Apple Watch Series 10 (46mm)' build`

Expected: BUILD SUCCEEDED, no errors anywhere.

Then check the layout at the *smallest* size, which is where the row is tightest:

Run: `xcrun simctl list devices available | grep Watch` and pick a 41mm or 42mm device. Boot it, install, launch, and screenshot the menu.

Expected: the row shows a record-dot button labelled "New session" and a narrow waveform button. **If "New session" is truncated with an ellipsis, drop the glyph rather than the words** — replace the wide button's label with `Text("New session")` and keep `record.circle` only on the narrow side by leaving the live button as it is. Re-screenshot to confirm.

- [ ] **Step 5: Verify the behavior by hand**

The app target has no tests and the watchOS simulator cannot replay swipes, so this pass is manual. On a simulator or a paired watch, with the relay reachable:

1. Tap the waveform button. Confirm the captions screen appears and the top-right indicator is a **hollow** ring.
2. Say something; confirm captions appear.
3. Tap Stop. Go to **Transcripts**. Confirm **no new transcript** was created.
4. Confirm the menu still offers "Continue last" pointing at your previous *saved* session, and that tapping it works.
5. Tap "New session", say something, Stop, and confirm a transcript **was** created and the indicator was a **filled** dot.
6. Relaunch after a live session and confirm you land on the menu rather than being dropped into a session.

If the relay is not reachable from the simulator, steps 1–2 will show the error screen instead; that still exercises `retry()`, and steps 3–6 need a real relay.

- [ ] **Step 6: Document it**

In `watch/README.md`, update the menu sentence on line 11 — it currently lists three items:

```markdown
than a pause — you land on a menu: **New session**, **Live caption**, **Continue last**,
**Transcripts**.
```

Then add a short section near the description of how sessions work, in the README's existing voice:

```markdown
### Live caption

**Live caption** — the narrow waveform button beside **New session** — captions
without keeping anything. The relay streams the text to your wrist and writes no
transcript, so there is no summary, no Notion page, and nothing in
**Transcripts** afterwards. The indicator on the captions screen is a hollow ring
rather than a filled dot to say so.

Because nothing is stored, a live session cannot be resumed: leaving it — Stop, a
back-swipe, or the app going to the background — ends it. Your last *saved*
session is left alone and still waiting under **Continue last**, though a launch
after a live session lands on the menu rather than resuming anything on its own.
```

- [ ] **Step 7: Commit**

```bash
git add watch/WatchCaptions/Views/HomeView.swift watch/WatchCaptions/Views/CaptionView.swift watch/WatchCaptions/WatchCaptionsApp.swift watch/README.md
git commit -m "feat(watch): add a live caption button that keeps nothing"
```

---

## Done when

- `cd backend && npm test && npm run build` passes.
- `swift test --package-path watch/CaptionCore` passes.
- The watch app builds, and the mac app still builds (`CaptionCore` is shared).
- The manual pass in Task 6 Step 5 is complete, including the "no transcript was created" check.

Deploying the relay is a separate step and deliberately out of this plan — the
watch change is useless until it ships, so `backend/DEPLOY.md` gets followed once
Tasks 1–2 are merged.
