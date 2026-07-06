# macOS Transcription App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Native macOS menu-bar app that live-captions mic + system audio through the existing Fly relay, with per-channel (Me/Them) transcripts browsable on every device via the relay; email notification removed.

**Architecture:** New `mac/` SwiftUI app reuses `watch/CaptionCore` (SessionController/CaptionStore/Relay). Mac streams stereo PCM (ch0 = mic, ch1 = system audio) over the relay's existing WebSocket `/stream` endpoint with `?channels=2`; backend opens Deepgram with `multichannel: true` and tags captions/transcript lines with `channel`. WS sessions gain transcript persistence (today only HTTP sessions persist). Email notifier deleted.

**Tech Stack:** SwiftUI (macOS 14+), AVAudioEngine, ScreenCaptureKit, URLSessionWebSocketTask, XcodeGen; backend: TypeScript/Node, vitest, @deepgram/sdk.

## Global Constraints

- Backend: TypeScript ESM, Node 20, vitest; run `npx vitest run` and `npm run build` (tsc --noEmit) from `backend/` before every commit that touches backend.
- Swift: CaptionCore package platforms already include `.macOS(.v13)`; Mac app deployment target macOS 14.0.
- Xcode projects are generated: `.xcodeproj` is gitignored; `project.yml` is the source of truth (`xcodegen generate`).
- Watch app behavior must not change: mono sessions carry no `channel` field anywhere.
- Protocol: caption JSON gains OPTIONAL `channel` (0 = mic/"Me", 1 = system/"Them"); absent on mono sessions.
- Bundle id prefix `com.jonyen.watchcaptions`; DEVELOPMENT_TEAM `7PZN69YDL4`; CODE_SIGN_STYLE Automatic.
- Commit after every task with the trailer lines used in this repo (Co-Authored-By + Claude-Session).

---

### Task 1: Remove email notification from backend

**Files:**
- Delete: `backend/src/mailer.ts`
- Modify: `backend/src/finalizer.ts`, `backend/src/finalizer.test.ts`, `backend/src/config.ts`, `backend/src/config.test.ts`, `backend/src/index.ts`, `backend/DEPLOY.md`, `backend/fly.toml`
- Uninstall: `nodemailer`, `@types/nodemailer`

**Interfaces:**
- Consumes: current `createFinalizer({dir, summarize, sendEmail})`.
- Produces: `createFinalizer(opts: {dir: string; summarize?: Summarize}): (t: FinalizedTranscript) => void` — no email types anywhere.

- [ ] **Step 1: Update finalizer tests — remove email cases**

Replace `backend/src/finalizer.test.ts` content with:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createFinalizer } from "./finalizer";
import { FinalizedTranscript, readTranscript, TranscriptStore, listTranscripts } from "./transcriptStore";

function transcript(texts: string[]): FinalizedTranscript {
  return {
    name: "2026-07-06T01-02-03Z_abc",
    sessionId: "abc",
    startedAt: "2026-07-06T01:02:03Z",
    endedAt: "2026-07-06T01:05:03Z",
    segments: texts.map((text, i) => ({ at: `2026-07-06T01:02:0${i}Z`, text })),
  };
}

const LONG = ["this is a reasonably long caption about something", "and another one"];
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("createFinalizer", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "finalizer-"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("stores the summary next to the transcript", async () => {
    const store = new TranscriptStore({ dir, now: () => Date.UTC(2026, 6, 6, 1, 2, 3) });
    store.append("abc", LONG[0]);
    const name = listTranscripts(dir)[0].name;

    const finalize = createFinalizer({ dir, summarize: async () => "A chat happened." });
    finalize({ ...transcript(LONG), name });
    await settle();

    expect(readTranscript(dir, name)?.summary).toBe("A chat happened.");
  });

  it("skips near-empty transcripts", async () => {
    const summarize = vi.fn(async () => "s");
    createFinalizer({ dir, summarize })(transcript(["hi"]));
    await settle();
    expect(summarize).not.toHaveBeenCalled();
  });

  it("survives a failing summarizer", async () => {
    const finalize = createFinalizer({
      dir,
      summarize: async () => {
        throw new Error("api down");
      },
    });
    expect(() => finalize(transcript(LONG))).not.toThrow();
    await settle();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx vitest run src/finalizer.test.ts`
Expected: FAIL (imports resolve but old email tests are gone; the suite may pass — the true failure arrives in Step 3 when types change. Continue.)

- [ ] **Step 3: Strip email from finalizer, config, index; delete mailer**

`backend/src/finalizer.ts` — replace whole file:

```typescript
import { FinalizedTranscript, writeSummary } from "./transcriptStore";
import { Summarize } from "./summarizer";

/** Skip summarizing transcripts with almost no content. */
const MIN_TRANSCRIPT_CHARS = 40;

export interface FinalizerOptions {
  /** Transcript directory the summary file is written to. */
  dir: string;
  /** Optional Claude summarizer. */
  summarize?: Summarize;
}

/**
 * Runs when a session's transcript finalizes: generate + store the summary.
 * Best-effort — the transcript is already safely on disk.
 */
export function createFinalizer(opts: FinalizerOptions): (t: FinalizedTranscript) => void {
  return (t) => {
    void run(opts, t);
  };
}

async function run(opts: FinalizerOptions, t: FinalizedTranscript): Promise<void> {
  const chars = t.segments.reduce((n, s) => n + s.text.length, 0);
  if (chars < MIN_TRANSCRIPT_CHARS || !opts.summarize) return;
  try {
    const summary = await opts.summarize(t);
    if (summary.length > 0) {
      writeSummary(opts.dir, t.name, summary);
      console.log(`summary written for ${t.name}`);
    }
  } catch (err) {
    console.error(`summary failed for ${t.name}:`, err);
  }
}
```

`backend/src/config.ts` — delete the `mail` field from `Config` and the whole `let mail: ...` block in `loadConfig`; delete `mail,` from the returned object.

`backend/src/index.ts` — remove `createTranscriptMailer` import, the `sendEmail` const and its log line; finalizer becomes:

```typescript
const transcripts = new TranscriptStore({
  dir: config.transcriptsDir,
  onFinalize: createFinalizer({ dir: config.transcriptsDir, summarize }),
});
```

`backend/src/config.test.ts` — delete the mail assertions: in the first test's `toEqual`, remove nothing (it has no mail key), and delete any test named "reads mail settings" if present. Keep transcriptsDir/anthropic tests.

Delete file: `rm backend/src/mailer.ts`

Uninstall: `cd backend && npm uninstall nodemailer @types/nodemailer`

- [ ] **Step 4: Update docs**

`backend/fly.toml`: change the TZ comment from `# timestamps in transcript emails` to `# local timestamps in transcript filenames/logs`.

`backend/DEPLOY.md`: delete step 6 (mail secrets) from One-time setup; in the "Transcripts & summaries" section delete the bullet about mail secrets/email; add bullet: `- Old installs: unset the retired mail secrets with fly secrets unset MAIL_USERNAME MAIL_PASSWORD NOTIFY_EMAIL_TO`.

- [ ] **Step 5: Run full backend suite + typecheck**

Run: `cd backend && npx vitest run && npm run build`
Expected: all tests pass, tsc clean, no references to mailer remain (`grep -rn mailer src/` returns nothing).

- [ ] **Step 6: Commit**

```bash
git add backend/
git commit -m "feat!: drop transcript email notification

Transcripts sync across devices via the relay (Mac app + web viewer);
the email ping is redundant. Summary generation stays."
```

---

### Task 2: Per-channel transcripts from Deepgram (provider layer)

**Files:**
- Modify: `backend/src/transcriptionProvider.ts`, `backend/src/deepgramProvider.ts`, `backend/src/deepgramProvider.test.ts`, `backend/src/fakeTranscriptionProvider.ts`

**Interfaces:**
- Produces: `Transcript { text: string; isFinal: boolean; channel?: number }`; `new DeepgramProvider(deepgram: DeepgramLike, optionOverrides?: Record<string, unknown>)` — overrides are merged over `DEEPGRAM_LIVE_OPTIONS` for every (re)connect.

- [ ] **Step 1: Write failing tests** — append to `backend/src/deepgramProvider.test.ts`:

```typescript
  it("passes option overrides to the live connection", () => {
    const opts: Record<string, unknown>[] = [];
    const client: DeepgramLike = {
      listen: {
        live: (o?: Record<string, unknown>) => {
          opts.push(o ?? {});
          return new FakeLiveConnection();
        },
      },
    };
    new DeepgramProvider(client, { channels: 2, multichannel: true });
    expect(opts[0]).toMatchObject({ channels: 2, multichannel: true, model: "nova-2" });
  });

  it("maps channel_index onto transcripts", () => {
    const { client, conns } = fakeDeepgram();
    const p = new DeepgramProvider(client);
    const got: (number | undefined)[] = [];
    p.onTranscript((t) => got.push(t.channel));
    conns[0].emit(LiveTranscriptionEvents.Transcript, {
      is_final: true,
      channel_index: [1, 2],
      channel: { alternatives: [{ transcript: "hi" }] },
    });
    conns[0].emit(LiveTranscriptionEvents.Transcript, transcriptPayload("mono", true));
    expect(got).toEqual([1, undefined]);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && npx vitest run src/deepgramProvider.test.ts`
Expected: FAIL — override not applied / `channel` undefined property mismatch.

- [ ] **Step 3: Implement**

`backend/src/transcriptionProvider.ts` — extend the interface:

```typescript
export interface Transcript {
  text: string;
  isFinal: boolean;
  /** Channel index for multichannel sessions (0 = mic, 1 = system). Absent = mono. */
  channel?: number;
}
```

`backend/src/deepgramProvider.ts`:
- Constructor: `constructor(private deepgram: DeepgramLike, private optionOverrides?: Record<string, unknown>)`.
- In `connect()`: `const conn = this.deepgram.listen.live({ ...DEEPGRAM_LIVE_OPTIONS, ...this.optionOverrides });`
- In the Transcript handler:

```typescript
      const channel = Array.isArray(data?.channel_index) ? Number(data.channel_index[0]) : undefined;
      this.transcriptHandler({
        text,
        isFinal: Boolean(data?.is_final),
        ...(channel !== undefined && !Number.isNaN(channel) ? { channel } : {}),
      });
```

`backend/src/fakeTranscriptionProvider.ts` — no interface change needed (it already emits `Transcript` objects); confirm `emitTranscript` passes through a `channel` field if given (it takes a `Transcript`, so it does).

- [ ] **Step 4: Run tests**

Run: `cd backend && npx vitest run src/deepgramProvider.test.ts`
Expected: PASS (16 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/transcriptionProvider.ts backend/src/deepgramProvider.ts backend/src/deepgramProvider.test.ts
git commit -m "feat: per-session deepgram options and channel-tagged transcripts"
```

---

### Task 3: Plumb `channel` through events and transcript storage

**Files:**
- Modify: `backend/src/captionSession.ts`, `backend/src/sessionStore.ts`, `backend/src/transcriptStore.ts`, `backend/src/captionSession.test.ts`, `backend/src/transcriptStore.test.ts`

**Interfaces:**
- Produces: `OutboundMessage` caption variant `{ type: "caption"; text: string; isFinal: boolean; channel?: number }`; `TranscriptStore.append(sessionId: string, text: string, channel?: number)`; `TranscriptSegment { at: string; text: string; channel?: number }`.

- [ ] **Step 1: Failing tests**

Append to `backend/src/transcriptStore.test.ts` inside the describe:

```typescript
  it("persists channel tags on segments", () => {
    const store = new TranscriptStore({ dir, now: () => T0 });
    store.append("abc", "me talking", 0);
    store.append("abc", "video audio", 1);
    store.append("abc", "mono line");
    const detail = readTranscript(dir, listTranscripts(dir)[0].name);
    expect(detail?.segments.map((s) => s.channel)).toEqual([0, 1, undefined]);
  });
```

Append to `backend/src/captionSession.test.ts` (match its existing style — it drives a `FakeTranscriptionProvider` and collects sent messages):

```typescript
  it("forwards the transcript channel on caption messages", () => {
    const provider = new FakeTranscriptionProvider();
    const sent: OutboundMessage[] = [];
    new CaptionSession(provider, (m) => sent.push(m));
    provider.emitTranscript({ text: "hi", isFinal: true, channel: 1 });
    provider.emitTranscript({ text: "yo", isFinal: true });
    expect(sent[0]).toEqual({ type: "caption", text: "hi", isFinal: true, channel: 1 });
    expect("channel" in sent[1]).toBe(false);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && npx vitest run src/transcriptStore.test.ts src/captionSession.test.ts`
Expected: FAIL (channel missing).

- [ ] **Step 3: Implement**

`backend/src/captionSession.ts`:

```typescript
export type OutboundMessage =
  | { type: "ready" }
  | { type: "caption"; text: string; isFinal: boolean; channel?: number }
  | { type: "error"; message: string };
```

and in the transcript handler:

```typescript
    this.provider.onTranscript((t) => {
      if (t.text.length === 0) return;
      this.send({
        type: "caption",
        text: t.text,
        isFinal: t.isFinal,
        ...(t.channel !== undefined ? { channel: t.channel } : {}),
      });
    });
```

`backend/src/transcriptStore.ts`:
- `TranscriptSegment` gains `channel?: number`.
- `append(sessionId: string, text: string, channel?: number)`: the JSONL line and in-memory segment become `{ at, text, ...(channel !== undefined ? { channel } : {}) }`.

`backend/src/sessionStore.ts` — in the buffered-send callback:

```typescript
      if (payload.type === "caption" && payload.isFinal) {
        this.transcripts?.append(id, payload.text, payload.channel);
      }
```

- [ ] **Step 4: Run full suite**

Run: `cd backend && npx vitest run && npm run build`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add backend/src/
git commit -m "feat: carry channel tags through caption events and JSONL transcripts"
```

---

### Task 4: WS endpoint — `?channels=2` and transcript persistence

**Files:**
- Modify: `backend/src/server.ts`, `backend/src/index.ts`, `backend/src/server.test.ts` (WS tests live here)

**Interfaces:**
- Produces: `StartServerOptions.createProvider: (opts?: { channels?: number }) => TranscriptionProvider`. WS sessions persist finals to `opts.transcripts` under a generated UUID and finalize on socket close.

- [ ] **Step 1: Failing tests** — append to `backend/src/server.test.ts` (reuse its existing helpers for opening a WS with a valid token; follow the file's current connection pattern):

```typescript
  it("passes channels=2 through to the provider factory", async () => {
    const seen: ({ channels?: number } | undefined)[] = [];
    // startServer with createProvider: (o) => { seen.push(o); return new FakeTranscriptionProvider(); }
    // connect ws to `/stream?token=good&channels=2`, await open
    expect(seen[0]).toEqual({ channels: 2 });
  });

  it("persists and finalizes transcripts for WS sessions", async () => {
    // startServer with transcripts: new TranscriptStore({ dir }) and transcriptsDir: dir
    // connect ws, provider.emitTranscript({ text: "ws line", isFinal: true, channel: 0 })
    // close ws, wait ~20ms
    // expect listTranscripts(dir) to have 1 entry with segmentCount 1
  });
```

Write these as real tests matching the harness in `server.test.ts` (it already opens WebSockets against a `startServer` on port 0 with fake providers). Use `mkdtempSync` for `dir` like `server.transcripts.test.ts` does.

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && npx vitest run src/server.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement in `backend/src/server.ts`**

```typescript
export interface ProviderOptions {
  channels?: number;
}

export interface StartServerOptions {
  port: number;
  authToken: string;
  createProvider: (opts?: ProviderOptions) => TranscriptionProvider;
  transcripts?: TranscriptStore;
  transcriptsDir?: string;
}
```

In the upgrade handler:

```typescript
    const channels = url.searchParams.get("channels") === "2" ? 2 : undefined;
    wss.handleUpgrade(req, socket, head, (ws) =>
      handleConnection(ws, opts, channels ? { channels } : undefined),
    );
```

`handleConnection` (import `randomUUID` from `"crypto"`):

```typescript
function handleConnection(
  ws: WebSocket,
  opts: StartServerOptions,
  providerOpts?: ProviderOptions,
): void {
  const provider = opts.createProvider(providerOpts);
  const sessionId = randomUUID();
  const send = (message: OutboundMessage) => {
    if (message.type === "caption" && message.isFinal) {
      opts.transcripts?.append(sessionId, message.text, message.channel);
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };
  const session = new CaptionSession(provider, send);

  let closed = false;
  const closeOnce = () => {
    if (closed) return;
    closed = true;
    session.close();
    opts.transcripts?.finalize(sessionId);
  };

  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) session.handleAudio(data);
  });
  ws.on("close", closeOnce);
  ws.on("error", closeOnce);
}
```

`backend/src/index.ts`:

```typescript
  createProvider: (opts) =>
    new DeepgramProvider(
      deepgram,
      opts?.channels === 2 ? { channels: 2, multichannel: true } : undefined,
    ),
```

- [ ] **Step 4: Run full suite**

Run: `cd backend && npx vitest run && npm run build`
Expected: PASS. (Existing tests using `createProvider: () => ...` still typecheck — a zero-arg function is assignable.)

- [ ] **Step 5: Commit**

```bash
git add backend/src/
git commit -m "feat: multichannel WS sessions with transcript persistence"
```

---

### Task 5: Viewer Me/Them labels + summary prompt channels

**Files:**
- Modify: `backend/src/viewerPage.ts`, `backend/src/summarizer.ts`, `backend/src/server.transcripts.test.ts`

- [ ] **Step 1: Failing test** — in `server.transcripts.test.ts`, extend the persistence test: emit `providers[0].emitTranscript({ text: "hello", isFinal: true, channel: 0 })` and assert the detail response segment carries `channel: 0`.

- [ ] **Step 2: Run to verify failure** (`npx vitest run src/server.transcripts.test.ts`) — FAIL until Tasks 2–4 merged; if already merged this passes — then skip to Step 3.

- [ ] **Step 3: Implement**

`backend/src/viewerPage.ts` — in `showDetail`, label lines by channel:

```javascript
    for (const s of t.segments) {
      const row = el('div', 'seg');
      const time = document.createElement('time');
      time.textContent = new Date(s.at).toLocaleTimeString();
      row.append(time);
      if (s.channel === 0) row.append(el('strong', '', 'Me: '));
      else if (s.channel === 1) row.append(el('strong', '', 'Them: '));
      row.append(document.createTextNode(s.text));
      content.append(row);
    }
```

`backend/src/summarizer.ts` — build the transcript text with labels and extend the system prompt:

```typescript
    const text = t.segments
      .map((s) => (s.channel === 0 ? `Me: ${s.text}` : s.channel === 1 ? `Them: ${s.text}` : s.text))
      .join("\n");
```

Add to the system prompt string: `"Lines prefixed 'Me:' were spoken by the user; lines prefixed 'Them:' are the other party or audio playing on their device."`

- [ ] **Step 4: Run suite + typecheck** — `cd backend && npx vitest run && npm run build` → PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/
git commit -m "feat: label Me/Them channels in viewer and summaries"
```

---

### Task 6: CaptionCore — channel-aware messages and store

**Files:**
- Modify: `watch/CaptionCore/Sources/CaptionCore/ServerMessage.swift`, `watch/CaptionCore/Sources/CaptionCore/CaptionStore.swift`, `watch/CaptionCore/Tests/CaptionCoreTests/ServerMessageTests.swift`, `watch/CaptionCore/Tests/CaptionCoreTests/CaptionStoreTests.swift`, `watch/CaptionCore/Tests/CaptionCoreTests/SessionControllerTests.swift` (only if it constructs `.caption` cases), `watch/WatchCaptions/Views/CaptionView.swift`, `watch/WatchCaptions/HTTPRelayClient.swift`

**Interfaces:**
- Produces: `ServerMessage.caption(text: String, isFinal: Bool, channel: Int?)`; `CaptionLine { text: String; channel: Int? }`; `CaptionStore.lines: [CaptionLine]`, `CaptionStore.partials: [Int: String]` (key = channel, mono uses 0), computed `partial: String` (mono convenience).

- [ ] **Step 1: Failing tests**

`ServerMessageTests.swift` — add:

```swift
    func testDecodesCaptionWithChannel() throws {
        let data = Data(#"{"type":"caption","text":"hi","isFinal":true,"channel":1}"#.utf8)
        XCTAssertEqual(try ServerMessage.decode(data), .caption(text: "hi", isFinal: true, channel: 1))
    }

    func testDecodesCaptionWithoutChannel() throws {
        let data = Data(#"{"type":"caption","text":"hi","isFinal":false}"#.utf8)
        XCTAssertEqual(try ServerMessage.decode(data), .caption(text: "hi", isFinal: false, channel: nil))
    }
```

`CaptionStoreTests.swift` — add:

```swift
    @MainActor func testTracksChannelsOnLinesAndPartials() {
        let store = CaptionStore()
        store.apply(.caption(text: "typing…", isFinal: false, channel: 1))
        XCTAssertEqual(store.partials[1], "typing…")
        store.apply(.caption(text: "done", isFinal: true, channel: 1))
        XCTAssertEqual(store.lines.last, CaptionLine(text: "done", channel: 1))
        XCTAssertEqual(store.partials[1], "")
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cd watch/CaptionCore && swift test`
Expected: FAIL — no `channel` associated value / no `CaptionLine`.

- [ ] **Step 3: Implement**

`ServerMessage.swift`:

```swift
public enum ServerMessage: Equatable {
    case ready
    case caption(text: String, isFinal: Bool, channel: Int?)
    case error(message: String)
}

extension ServerMessage: Decodable {
    private enum CodingKeys: String, CodingKey { case type, text, isFinal, message, channel }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .type) {
        case "ready":
            self = .ready
        case "caption":
            self = .caption(
                text: try c.decode(String.self, forKey: .text),
                isFinal: try c.decode(Bool.self, forKey: .isFinal),
                channel: try c.decodeIfPresent(Int.self, forKey: .channel)
            )
        case "error":
            self = .error(message: try c.decode(String.self, forKey: .message))
        case let other:
            throw DecodingError.dataCorruptedError(
                forKey: .type, in: c, debugDescription: "unknown message type \(other)")
        }
    }
}
```

`CaptionStore.swift`:

```swift
/// One finalized caption line, tagged with its capture channel when known.
public struct CaptionLine: Equatable, Identifiable {
    public let id = UUID()
    public let text: String
    public let channel: Int?
    public init(text: String, channel: Int?) {
        self.text = text
        self.channel = channel
    }
    public static func == (lhs: CaptionLine, rhs: CaptionLine) -> Bool {
        lhs.text == rhs.text && lhs.channel == rhs.channel
    }
}
```

In `CaptionStore`: `@Published public private(set) var lines: [CaptionLine] = []`, `@Published public private(set) var partials: [Int: String] = [:]`, computed `public var partial: String { partials[0] ?? "" }`. `apply` becomes:

```swift
        case .caption(let text, let isFinal, let channel):
            let key = channel ?? 0
            if isFinal {
                if !text.isEmpty { lines.append(CaptionLine(text: text, channel: channel)) }
                partials[key] = ""
            } else {
                partials[key] = text
            }
```

`reset()` clears both (`lines = []; partials = [:]`).

Watch call sites:
- `HTTPRelayClient.swift` `handle(_:)` caption branch: `emit(.caption(text: text, isFinal: isFinal, channel: event["channel"] as? Int))`.
- `CaptionView.swift`: wherever it iterates `store.lines` as strings, use `line.text` (and `id: \.id` if it used `\.self`). Read the file, make the minimal edit.
- Fix any `.caption(text:isFinal:)` constructions in tests by adding `channel: nil`.

- [ ] **Step 4: Run tests**

Run: `cd watch/CaptionCore && swift test`
Expected: PASS.
Also build the watch app to catch view fallout: `cd watch && xcodegen generate && xcodebuild -project WatchCaptions.xcodeproj -scheme WatchCaptions -destination 'generic/platform=watchOS Simulator' build` (skip if no watchOS SDK available; note it in the commit).

- [ ] **Step 5: Commit**

```bash
git add watch/
git commit -m "feat: channel-aware captions in CaptionCore"
```

---

### Task 7: Mac app scaffold (XcodeGen project + menu bar shell)

**Files:**
- Create: `mac/project.yml`, `mac/MacCaptions/MacCaptionsApp.swift`, `mac/MacCaptions/AppModel.swift` (stub), `mac/README.md`
- Modify: `.gitignore` (ensure `*.xcodeproj` already ignored — check; watch's is)

**Interfaces:**
- Produces: buildable `MacCaptions.app` menu-bar-only app (LSUIElement) with Start/Stop placeholder; `AppModel: ObservableObject` with `@Published var capturing = false` for later tasks to flesh out.

- [ ] **Step 1: Install xcodegen if missing**

Run: `which xcodegen || brew install xcodegen`

- [ ] **Step 2: Write `mac/project.yml`**

```yaml
name: MacCaptions
options:
  bundleIdPrefix: com.jonyen.watchcaptions
  deploymentTarget:
    macOS: "14.0"
packages:
  CaptionCore:
    path: ../watch/CaptionCore
targets:
  MacCaptions:
    type: application
    platform: macOS
    sources:
      - path: MacCaptions
    dependencies:
      - package: CaptionCore
    info:
      path: MacCaptions/Info.plist
      properties:
        CFBundleDisplayName: Captions
        LSUIElement: true
        NSMicrophoneUsageDescription: "Captions your side of conversations."
        NSAudioCaptureUsageDescription: "Captions audio playing on your Mac (calls, videos)."
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: com.jonyen.watchcaptions.mac
        GENERATE_INFOPLIST_FILE: NO
        MARKETING_VERSION: "1.0"
        CURRENT_PROJECT_VERSION: "1"
        DEVELOPMENT_TEAM: "7PZN69YDL4"
        CODE_SIGN_STYLE: Automatic
        ENABLE_HARDENED_RUNTIME: YES
  MacCaptionsTests:
    type: bundle.unit-test
    platform: macOS
    sources:
      - path: MacCaptionsTests
    dependencies:
      - target: MacCaptions
```

Also create empty `mac/MacCaptionsTests/` with a placeholder `SmokeTest.swift`:

```swift
import XCTest

final class SmokeTest: XCTestCase {
    func testTruth() { XCTAssertTrue(true) }
}
```

- [ ] **Step 3: Write the app shell**

`mac/MacCaptions/MacCaptionsApp.swift`:

```swift
import SwiftUI

@main
struct MacCaptionsApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        MenuBarExtra("Captions", systemImage: model.capturing ? "captions.bubble.fill" : "captions.bubble") {
            Button(model.capturing ? "Stop Captions" : "Start Captions") {
                model.toggle()
            }
            Divider()
            Button("Quit") { NSApplication.shared.terminate(nil) }
        }
    }
}
```

`mac/MacCaptions/AppModel.swift` (stub for now):

```swift
import Foundation

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var capturing = false

    func toggle() {
        capturing.toggle()
    }
}
```

`mac/README.md`: mirror `watch/README.md` style — xcodegen generate, open project, permissions needed (mic + Screen Recording), settings for relay URL/token.

- [ ] **Step 4: Generate + build**

Run: `cd mac && xcodegen generate && xcodebuild -project MacCaptions.xcodeproj -scheme MacCaptions -destination 'platform=macOS' build`
Expected: BUILD SUCCEEDED.

- [ ] **Step 5: Commit**

```bash
git add mac/ .gitignore
git commit -m "feat: scaffold macOS menu bar app (MacCaptions)"
```

---

### Task 8: WebSocketRelay with auto-reconnect

**Files:**
- Create: `mac/MacCaptions/WebSocketRelay.swift`, `mac/MacCaptionsTests/ReconnectPolicyTests.swift`

**Interfaces:**
- Consumes: `CaptionCore.Relay`, `ServerMessage.decode`.
- Produces: `final class WebSocketRelay: Relay` with `init(base: URL, token: String, channels: Int)`; pure `struct ReconnectPolicy { mutating func nextDelay() -> TimeInterval?; mutating func reset() }` (0.5, 1, 2, 4, 8, 8… capped; returns nil after `maxElapsed` 30s of consecutive failures).

- [ ] **Step 1: Failing test** — `mac/MacCaptionsTests/ReconnectPolicyTests.swift`:

```swift
import XCTest
@testable import MacCaptions

final class ReconnectPolicyTests: XCTestCase {
    func testBacksOffAndCaps() {
        var p = ReconnectPolicy()
        XCTAssertEqual(p.nextDelay(), 0.5)
        XCTAssertEqual(p.nextDelay(), 1.0)
        XCTAssertEqual(p.nextDelay(), 2.0)
        XCTAssertEqual(p.nextDelay(), 4.0)
        XCTAssertEqual(p.nextDelay(), 8.0)
        XCTAssertEqual(p.nextDelay(), 8.0)
    }

    func testGivesUpAfterMaxElapsed() {
        var p = ReconnectPolicy()
        var total: TimeInterval = 0
        while let d = p.nextDelay() { total += d }
        XCTAssertGreaterThanOrEqual(total, 30)
        XCTAssertNil(p.nextDelay())
    }

    func testResetRestoresBudget() {
        var p = ReconnectPolicy()
        _ = p.nextDelay(); _ = p.nextDelay()
        p.reset()
        XCTAssertEqual(p.nextDelay(), 0.5)
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd mac && xcodegen generate && xcodebuild test -project MacCaptions.xcodeproj -scheme MacCaptions -destination 'platform=macOS'`
Expected: FAIL — `ReconnectPolicy` unresolved.

- [ ] **Step 3: Implement `mac/MacCaptions/WebSocketRelay.swift`**

```swift
import Foundation
import CaptionCore

/// Reconnect schedule: 0.5s → 8s capped, giving up after ~30s of consecutive failure.
struct ReconnectPolicy {
    private var attempt = 0
    private var elapsed: TimeInterval = 0
    private let maxElapsed: TimeInterval = 30

    mutating func nextDelay() -> TimeInterval? {
        guard elapsed < maxElapsed else { return nil }
        let delay = min(0.5 * pow(2, Double(attempt)), 8)
        attempt += 1
        elapsed += delay
        return delay
    }

    mutating func reset() {
        attempt = 0
        elapsed = 0
    }
}

/// `Relay` over the backend's WebSocket endpoint. Reconnects transparently on
/// drops; calls `onClose` only when the reconnect budget is exhausted.
final class WebSocketRelay: NSObject, Relay {
    var onMessage: (@MainActor (ServerMessage) -> Void)?
    var onClose: (@MainActor () -> Void)?

    private let url: URL
    private var task: URLSessionWebSocketTask?
    private var session: URLSession!
    private var policy = ReconnectPolicy()
    private var stopped = true

    init(base: URL, token: String, channels: Int) {
        var c = URLComponents(url: base.appendingPathComponent("stream"), resolvingAgainstBaseURL: false)!
        c.scheme = base.scheme == "http" ? "ws" : "wss"
        c.queryItems = [
            URLQueryItem(name: "token", value: token),
            URLQueryItem(name: "channels", value: String(channels)),
        ]
        url = c.url!
        super.init()
        session = URLSession(configuration: .default, delegate: nil, delegateQueue: nil)
    }

    func connect() {
        stopped = false
        policy.reset()
        open()
    }

    func send(_ audio: Data) {
        task?.send(.data(audio)) { _ in }  // drop errors; reconnect path handles the failure
    }

    func close() {
        stopped = true
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
    }

    // MARK: - Internals

    private func open() {
        let t = session.webSocketTask(with: url)
        task = t
        t.resume()
        receiveLoop(on: t)
    }

    private func receiveLoop(on t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            guard let self, self.task === t else { return }
            switch result {
            case .success(let message):
                self.policy.reset()
                if let serverMessage = self.decode(message), let onMessage = self.onMessage {
                    Task { @MainActor in onMessage(serverMessage) }
                }
                self.receiveLoop(on: t)
            case .failure:
                self.handleDrop()
            }
        }
    }

    private func decode(_ message: URLSessionWebSocketTask.Message) -> ServerMessage? {
        switch message {
        case .string(let s): return try? ServerMessage.decode(Data(s.utf8))
        case .data(let d): return try? ServerMessage.decode(d)
        @unknown default: return nil
        }
    }

    private func handleDrop() {
        guard !stopped else { return }
        guard let delay = policy.nextDelay() else {
            stopped = true
            if let onClose { Task { @MainActor in onClose() } }
            return
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, !self.stopped else { return }
            self.open()
        }
    }
}
```

Note: on reconnect the backend creates a fresh session (new transcript file) — matches the spec's accepted session boundary. The server suppresses nothing; a second `ready` arrives and `CaptionStore.apply(.ready)` is a harmless state refresh.

- [ ] **Step 4: Run tests** — same xcodebuild test command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mac/
git commit -m "feat: WebSocket relay with capped auto-reconnect"
```

---

### Task 9: Stereo interleaver

**Files:**
- Create: `mac/MacCaptions/Interleaver.swift`, `mac/MacCaptionsTests/InterleaverTests.swift`

**Interfaces:**
- Produces: `final class Interleaver` — `func pushMic(_ samples: [Int16])`, `func pushSystem(_ samples: [Int16])`, `func drainStereoFrames() -> Data`. Output: interleaved Int16 little-endian `[mic0, sys0, mic1, sys1, …]`; frame count = max(available mic, available system), shorter side padded with zeros so channels stay time-aligned; both buffers empty after drain.

- [ ] **Step 1: Failing tests** — `mac/MacCaptionsTests/InterleaverTests.swift`:

```swift
import XCTest
@testable import MacCaptions

final class InterleaverTests: XCTestCase {
    private func samples(_ data: Data) -> [Int16] {
        data.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
    }

    func testInterleavesEqualLengthSources() {
        let i = Interleaver()
        i.pushMic([1, 2])
        i.pushSystem([10, 20])
        XCTAssertEqual(samples(i.drainStereoFrames()), [1, 10, 2, 20])
    }

    func testPadsShorterSideWithSilence() {
        let i = Interleaver()
        i.pushMic([1, 2, 3])
        i.pushSystem([10])
        XCTAssertEqual(samples(i.drainStereoFrames()), [1, 10, 2, 0, 3, 0])
    }

    func testMissingSourceEntirelyIsSilence() {
        let i = Interleaver()
        i.pushSystem([7])
        XCTAssertEqual(samples(i.drainStereoFrames()), [0, 7])
    }

    func testDrainEmptiesBuffers() {
        let i = Interleaver()
        i.pushMic([1])
        _ = i.drainStereoFrames()
        XCTAssertEqual(i.drainStereoFrames(), Data())
    }
}
```

- [ ] **Step 2: Run to verify failure** — xcodebuild test → FAIL (`Interleaver` unresolved).

- [ ] **Step 3: Implement `mac/MacCaptions/Interleaver.swift`**

```swift
import Foundation

/// Merges two mono 16 kHz Int16 streams into interleaved stereo frames
/// (channel 0 = mic, channel 1 = system audio). Thread-safe: capture callbacks
/// push from audio threads; a timer drains on a worker queue.
final class Interleaver {
    private var mic: [Int16] = []
    private var system: [Int16] = []
    private let lock = NSLock()

    func pushMic(_ samples: [Int16]) {
        lock.lock(); defer { lock.unlock() }
        mic.append(contentsOf: samples)
    }

    func pushSystem(_ samples: [Int16]) {
        lock.lock(); defer { lock.unlock() }
        system.append(contentsOf: samples)
    }

    /// Interleave everything buffered so far, padding the shorter channel with
    /// silence so the two stay time-aligned. Returns little-endian PCM bytes.
    func drainStereoFrames() -> Data {
        lock.lock()
        let m = mic, s = system
        mic = []; system = []
        lock.unlock()

        let frames = max(m.count, s.count)
        guard frames > 0 else { return Data() }
        var out = [Int16](repeating: 0, count: frames * 2)
        for f in 0..<frames {
            out[f * 2] = f < m.count ? m[f] : 0
            out[f * 2 + 1] = f < s.count ? s[f] : 0
        }
        return out.withUnsafeBufferPointer { Data(buffer: $0) }
    }
}
```

- [ ] **Step 4: Run tests** — xcodebuild test → PASS.

- [ ] **Step 5: Commit**

```bash
git add mac/
git commit -m "feat: stereo interleaver for mic + system audio"
```

---

### Task 10: Capture sources + DualCapture

**Files:**
- Create: `mac/MacCaptions/MicSource.swift`, `mac/MacCaptions/SystemAudioSource.swift`, `mac/MacCaptions/DualCapture.swift`, `mac/MacCaptions/MacPermissions.swift`

**Interfaces:**
- Consumes: `Interleaver`, `CaptionCore.AudioCapturing`, `CaptionCore.MicPermissionProviding`.
- Produces: `final class DualCapture: AudioCapturing` — `init(micEnabled: @escaping () -> Bool, systemEnabled: @escaping () -> Bool)`; `start(onChunk:)` starts enabled sources + a 100 ms drain timer emitting stereo Data; `stop()` tears everything down. `struct MacPermissions: MicPermissionProviding` (AVCaptureDevice mic authorization).

- [ ] **Step 1: Implement `MicSource.swift`** (no unit test — hardware; converter mirrors the tested watch approach)

```swift
import AVFoundation

/// Mic capture producing 16 kHz mono Int16 samples (same conversion approach
/// as the watch AudioCapture, minus AVAudioSession, which doesn't exist on macOS).
final class MicSource {
    private let engine = AVAudioEngine()
    private var converter: AVAudioConverter?
    private let targetFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!

    func start(onSamples: @escaping ([Int16]) -> Void) throws {
        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard let converter = AVAudioConverter(from: inputFormat, to: targetFormat) else {
            throw CaptureError.converterUnavailable
        }
        self.converter = converter

        input.installTap(onBus: 0, bufferSize: 1_600, format: inputFormat) { [weak self] buffer, _ in
            guard let self, let samples = self.convert(buffer), !samples.isEmpty else { return }
            onSamples(samples)
        }
        engine.prepare()
        try engine.start()
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        converter = nil
    }

    private func convert(_ buffer: AVAudioPCMBuffer) -> [Int16]? {
        guard let converter else { return nil }
        let ratio = targetFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1
        guard let out = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else {
            return nil
        }
        var consumed = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if consumed { status.pointee = .noDataNow; return nil }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, let channel = out.int16ChannelData, out.frameLength > 0 else {
            return nil
        }
        return Array(UnsafeBufferPointer(start: channel[0], count: Int(out.frameLength)))
    }

    enum CaptureError: Error { case converterUnavailable }
}
```

- [ ] **Step 2: Implement `SystemAudioSource.swift`**

```swift
import ScreenCaptureKit
import AVFoundation

/// System-audio capture via ScreenCaptureKit, resampled to 16 kHz mono Int16.
/// Requires the Screen Recording permission (audio rides on the capture stream).
final class SystemAudioSource: NSObject, SCStreamOutput {
    private var stream: SCStream?
    private var converter: AVAudioConverter?
    private var onSamples: (([Int16]) -> Void)?
    private let targetFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!
    private let queue = DispatchQueue(label: "system.audio.capture")

    func start(onSamples: @escaping ([Int16]) -> Void) async throws {
        self.onSamples = onSamples
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let display = content.displays.first else { throw CaptureError.noDisplay }

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        // Keep video overhead minimal; we only want audio.
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)

        let stream = SCStream(filter: filter, configuration: config, delegate: nil)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        try await stream.startCapture()
        self.stream = stream
    }

    func stop() {
        let s = stream
        stream = nil
        converter = nil
        onSamples = nil
        Task { try? await s?.stopCapture() }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio,
              let onSamples,
              let pcm = sampleBuffer.toPCMBuffer() else { return }
        if converter == nil || converter?.inputFormat != pcm.format {
            converter = AVAudioConverter(from: pcm.format, to: targetFormat)
        }
        guard let converter else { return }
        let ratio = targetFormat.sampleRate / pcm.format.sampleRate
        let capacity = AVAudioFrameCount(Double(pcm.frameLength) * ratio) + 1
        guard let out = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { return }
        var consumed = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if consumed { status.pointee = .noDataNow; return nil }
            consumed = true
            status.pointee = .haveData
            return pcm
        }
        guard error == nil, let channel = out.int16ChannelData, out.frameLength > 0 else { return }
        onSamples(Array(UnsafeBufferPointer(start: channel[0], count: Int(out.frameLength))))
    }

    enum CaptureError: Error { case noDisplay }
}

private extension CMSampleBuffer {
    /// Wrap a ScreenCaptureKit audio sample buffer in an AVAudioPCMBuffer.
    func toPCMBuffer() -> AVAudioPCMBuffer? {
        guard let desc = CMSampleBufferGetFormatDescription(self),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(desc),
              let format = AVAudioFormat(streamDescription: asbd) else { return nil }
        let frames = AVAudioFrameCount(CMSampleBufferGetNumSamples(self))
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return nil }
        buffer.frameLength = frames
        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(
            self, at: 0, frameCount: Int32(frames), into: buffer.mutableAudioBufferList)
        return status == noErr ? buffer : nil
    }
}
```

- [ ] **Step 3: Implement `DualCapture.swift` and `MacPermissions.swift`**

`DualCapture.swift`:

```swift
import Foundation
import CaptionCore

/// Captures mic + system audio, interleaving them into 100 ms stereo chunks
/// (ch0 = mic, ch1 = system). Conforms to CaptionCore.AudioCapturing so
/// SessionController drives it exactly like the watch's mono capture.
final class DualCapture: AudioCapturing {
    private let micEnabled: () -> Bool
    private let systemEnabled: () -> Bool
    private let mic = MicSource()
    private let system = SystemAudioSource()
    private let interleaver = Interleaver()
    private var timer: DispatchSourceTimer?
    private let queue = DispatchQueue(label: "dualcapture.drain")

    init(micEnabled: @escaping () -> Bool, systemEnabled: @escaping () -> Bool) {
        self.micEnabled = micEnabled
        self.systemEnabled = systemEnabled
    }

    func start(onChunk: @escaping (Data) -> Void) throws {
        if micEnabled() {
            try mic.start { [interleaver] in interleaver.pushMic($0) }
        }
        if systemEnabled() {
            let system = self.system
            let interleaver = self.interleaver
            Task {
                do {
                    try await system.start { interleaver.pushSystem($0) }
                } catch {
                    // System capture failing shouldn't kill the mic-only session.
                    print("system audio capture failed: \(error)")
                }
            }
        }
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 0.1, repeating: 0.1)
        t.setEventHandler { [interleaver] in
            let data = interleaver.drainStereoFrames()
            if !data.isEmpty { onChunk(data) }
        }
        t.resume()
        timer = t
    }

    func stop() {
        timer?.cancel()
        timer = nil
        mic.stop()
        system.stop()
    }
}
```

`MacPermissions.swift`:

```swift
import AVFoundation
import CaptionCore

struct MacPermissions: MicPermissionProviding {
    func ensureGranted() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return true
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .audio)
        default: return false
        }
    }
}
```

- [ ] **Step 4: Build**

Run: `cd mac && xcodegen generate && xcodebuild -project MacCaptions.xcodeproj -scheme MacCaptions -destination 'platform=macOS' build`
Expected: BUILD SUCCEEDED. Run unit tests too (interleaver/reconnect still pass).

- [ ] **Step 5: Commit**

```bash
git add mac/
git commit -m "feat: mic + system audio capture with stereo interleave"
```

---

### Task 11: Wire session, menu UI, floating caption panel

**Files:**
- Create: `mac/MacCaptions/CaptionPanel.swift`, `mac/MacCaptions/SettingsStore.swift`
- Modify: `mac/MacCaptions/AppModel.swift`, `mac/MacCaptions/MacCaptionsApp.swift`

**Interfaces:**
- Consumes: `SessionController`, `CaptionStore`, `WebSocketRelay`, `DualCapture`, `MacPermissions`.
- Produces: `SettingsStore` — `var relayURL: URL?` (UserDefaults key `relayURL`), `var token: String` (Keychain service `com.jonyen.watchcaptions.mac`, account `relay-token`); `AppModel.start()/stop()`, `@Published micOn/systemOn`; `CaptionPanelController.show(store:)/hide()`.

- [ ] **Step 1: Implement `SettingsStore.swift`**

```swift
import Foundation
import Security

/// Relay URL in UserDefaults; auth token in the Keychain.
final class SettingsStore: ObservableObject {
    private static let service = "com.jonyen.watchcaptions.mac"
    private static let account = "relay-token"

    @Published var relayURLString: String {
        didSet { UserDefaults.standard.set(relayURLString, forKey: "relayURL") }
    }
    @Published var token: String {
        didSet { Self.saveToken(token) }
    }

    init() {
        relayURLString = UserDefaults.standard.string(forKey: "relayURL") ?? ""
        token = Self.loadToken()
    }

    var relayURL: URL? { URL(string: relayURLString) }
    var configured: Bool { relayURL != nil && !token.isEmpty }

    private static func loadToken() -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return "" }
        return String(data: data, encoding: .utf8) ?? ""
    }

    private static func saveToken(_ token: String) {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(base as CFDictionary)
        guard !token.isEmpty else { return }
        var add = base
        add[kSecValueData as String] = Data(token.utf8)
        SecItemAdd(add as CFDictionary, nil)
    }
}
```

- [ ] **Step 2: Implement `CaptionPanel.swift`**

```swift
import SwiftUI
import CaptionCore

/// Floating, non-activating, always-on-top translucent caption panel.
@MainActor
final class CaptionPanelController {
    private var panel: NSPanel?

    func show(store: CaptionStore) {
        if panel != nil { return }
        let view = NSHostingView(rootView: CaptionPanelView(store: store))
        let p = NSPanel(
            contentRect: NSRect(x: 0, y: 120, width: 560, height: 140),
            styleMask: [.nonactivatingPanel, .titled, .fullSizeContentView, .resizable],
            backing: .buffered, defer: false)
        p.level = .floating
        p.titleVisibility = .hidden
        p.titlebarAppearsTransparent = true
        p.isMovableByWindowBackground = true
        p.backgroundColor = .clear
        p.isOpaque = false
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        p.contentView = view
        p.center()
        p.orderFrontRegardless()
        panel = p
    }

    func hide() {
        panel?.orderOut(nil)
        panel = nil
    }
}

struct CaptionPanelView: View {
    @ObservedObject var store: CaptionStore

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(store.lines.suffix(3)) { line in
                Text(label(line.channel) + line.text)
                    .font(.system(size: 18, weight: .medium))
            }
            ForEach(store.partials.sorted(by: { $0.key < $1.key }), id: \.key) { channel, text in
                if !text.isEmpty {
                    Text(label(channel) + text)
                        .font(.system(size: 18, weight: .medium))
                        .foregroundStyle(.secondary)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
        .padding(14)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
        .padding(8)
    }

    private func label(_ channel: Int?) -> String {
        switch channel {
        case 0: return "Me: "
        case 1: return "Them: "
        default: return ""
        }
    }
}
```

- [ ] **Step 3: Flesh out `AppModel.swift`**

```swift
import Foundation
import CaptionCore

@MainActor
final class AppModel: ObservableObject {
    let store = CaptionStore()
    let settings = SettingsStore()
    @Published private(set) var capturing = false
    @Published var micOn = true
    @Published var systemOn = true

    private var controller: SessionController?
    private let panel = CaptionPanelController()

    func toggle() {
        capturing ? stop() : start()
    }

    func start() {
        guard let base = settings.relayURL, settings.configured else {
            store.setError("Set the relay URL and token in Settings.")
            return
        }
        let relay = WebSocketRelay(base: base, token: settings.token, channels: 2)
        let capture = DualCapture(
            micEnabled: { [weak self] in self?.micOn ?? false },
            systemEnabled: { [weak self] in self?.systemOn ?? false })
        let controller = SessionController(
            store: store, relay: relay, audio: capture, permission: MacPermissions())
        self.controller = controller
        capturing = true
        panel.show(store: store)
        Task { await controller.start() }
    }

    func stop() {
        controller?.stop()
        controller = nil
        capturing = false
        panel.hide()
    }
}
```

- [ ] **Step 4: Update `MacCaptionsApp.swift`**

```swift
import SwiftUI

@main
struct MacCaptionsApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        MenuBarExtra("Captions", systemImage: model.capturing ? "captions.bubble.fill" : "captions.bubble") {
            Button(model.capturing ? "Stop Captions" : "Start Captions") { model.toggle() }
            Toggle("Microphone", isOn: $model.micOn)
            Toggle("System Audio", isOn: $model.systemOn)
            Divider()
            SettingsLink { Text("Settings…") }
            Button("Quit") { NSApplication.shared.terminate(nil) }
        }
        Settings {
            Form {
                TextField("Relay URL", text: $model.settings.relayURLString,
                          prompt: Text("https://watch-captions-relay.fly.dev"))
                SecureField("Auth token", text: $model.settings.token)
            }
            .padding()
            .frame(width: 420)
        }
    }
}
```

(`$model.settings.relayURLString` requires exposing settings as an `ObservableObject` on the model; use `@ObservedObject` wrappers in a small `SettingsView` if direct binding through the model fights the compiler — keep the simplest form that builds.)

- [ ] **Step 5: Build + manual smoke**

Run: `cd mac && xcodegen generate && xcodebuild -project MacCaptions.xcodeproj -scheme MacCaptions -destination 'platform=macOS' build`
Expected: BUILD SUCCEEDED.
Manual: run the app from Xcode, set relay URL + token in Settings, Start Captions, speak → **Me:** lines appear in the floating panel; play a video → **Them:** lines. First run prompts for mic + Screen Recording permissions (Screen Recording requires app restart after granting).

- [ ] **Step 6: Commit**

```bash
git add mac/
git commit -m "feat: live caption session with floating panel on macOS"
```

---

### Task 12: Transcripts window

**Files:**
- Create: `mac/MacCaptions/TranscriptsView.swift`, `mac/MacCaptions/RelayAPI.swift`
- Modify: `mac/MacCaptions/MacCaptionsApp.swift`

**Interfaces:**
- Consumes: `SettingsStore` (relayURL + token), backend `GET /v1/transcripts` → `{transcripts: [{name, startedAt, segmentCount, preview, hasSummary}]}`, `GET /v1/transcripts/<name>` → `{name, segments: [{at, text, channel?}], summary}`.
- Produces: `RelayAPI` — `func list() async throws -> [TranscriptSummary]`, `func detail(name: String) async throws -> TranscriptDetail` (Codable structs mirroring the JSON above).

- [ ] **Step 1: Implement `RelayAPI.swift`**

```swift
import Foundation

struct TranscriptSummary: Codable, Identifiable {
    let name: String
    let startedAt: String
    let segmentCount: Int
    let preview: String
    let hasSummary: Bool
    var id: String { name }
}

struct TranscriptSegment: Codable, Identifiable {
    let at: String
    let text: String
    let channel: Int?
    var id: String { at + text }
}

struct TranscriptDetail: Codable {
    let name: String
    let segments: [TranscriptSegment]
    let summary: String?
}

/// Thin client for the relay's transcript endpoints.
struct RelayAPI {
    let base: URL
    let token: String

    private struct ListResponse: Codable { let transcripts: [TranscriptSummary] }

    func list() async throws -> [TranscriptSummary] {
        try await get(path: "v1/transcripts", as: ListResponse.self).transcripts
    }

    func detail(name: String) async throws -> TranscriptDetail {
        try await get(path: "v1/transcripts/\(name)", as: TranscriptDetail.self)
    }

    private func get<T: Codable>(path: String, as type: T.Type) async throws -> T {
        var c = URLComponents(url: base.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        c.queryItems = [URLQueryItem(name: "token", value: token)]
        let (data, response) = try await URLSession.shared.data(from: c.url!)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
```

- [ ] **Step 2: Implement `TranscriptsView.swift`**

```swift
import SwiftUI

struct TranscriptsView: View {
    let api: RelayAPI?
    @State private var transcripts: [TranscriptSummary] = []
    @State private var selected: TranscriptDetail?
    @State private var error: String?

    var body: some View {
        NavigationSplitView {
            List(transcripts, selection: Binding(
                get: { selected?.name },
                set: { name in
                    guard let name, let api else { return }
                    Task { selected = try? await api.detail(name: name) }
                }
            )) { t in
                VStack(alignment: .leading) {
                    Text(formatted(t.startedAt)).font(.headline)
                    Text("\(t.segmentCount) captions\(t.hasSummary ? " · summary" : "")")
                        .font(.caption).foregroundStyle(.secondary)
                    Text(t.preview).lineLimit(1).font(.caption).foregroundStyle(.secondary)
                }
                .tag(t.name)
            }
            .navigationTitle("Transcripts")
        } detail: {
            if let d = selected {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        if let summary = d.summary {
                            Text("Summary").font(.title3.bold())
                            Text(summary).textSelection(.enabled)
                            Divider()
                        }
                        Text("Transcript").font(.title3.bold())
                        ForEach(d.segments) { s in
                            HStack(alignment: .top, spacing: 6) {
                                Text(label(s.channel)).bold().frame(width: 50, alignment: .leading)
                                Text(s.text).textSelection(.enabled)
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
                }
            } else if let error {
                Text(error).foregroundStyle(.red)
            } else {
                Text("Select a transcript")
            }
        }
        .task { await refresh() }
        .toolbar { Button("Refresh") { Task { await refresh() } } }
    }

    private func refresh() async {
        guard let api else {
            error = "Set the relay URL and token in Settings."
            return
        }
        do { transcripts = try await api.list() } catch { self.error = "\(error)" }
    }

    private func label(_ channel: Int?) -> String {
        switch channel {
        case 0: return "Me"
        case 1: return "Them"
        default: return ""
        }
    }

    private func formatted(_ iso: String) -> String {
        guard let date = ISO8601DateFormatter().date(from: iso) else { return iso }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}
```

- [ ] **Step 3: Add window scene + menu item** in `MacCaptionsApp.swift`:

Inside the `MenuBarExtra` content, above Settings:

```swift
            Button("Transcripts…") { openWindow(id: "transcripts") }
```

(add `@Environment(\.openWindow) private var openWindow` to the App struct), and a new scene:

```swift
        Window("Transcripts", id: "transcripts") {
            TranscriptsView(api: model.settings.configured
                ? RelayAPI(base: model.settings.relayURL!, token: model.settings.token)
                : nil)
        }
        .defaultSize(width: 720, height: 480)
```

- [ ] **Step 4: Build + manual check**

Run: `cd mac && xcodegen generate && xcodebuild -project MacCaptions.xcodeproj -scheme MacCaptions -destination 'platform=macOS' build`
Expected: BUILD SUCCEEDED. Manual: Transcripts… opens window listing existing watch sessions from the live relay.

- [ ] **Step 5: Commit**

```bash
git add mac/
git commit -m "feat: transcripts browser window backed by relay API"
```

---

### Task 13: End-to-end verification, docs, deploy

**Files:**
- Modify: `README.md` (root — mention mac/), `mac/README.md` (final instructions), `backend/DEPLOY.md` (already updated in Task 1 — verify)

- [ ] **Step 1: Full test sweep**

```bash
cd backend && npx vitest run && npm run build
cd ../watch/CaptionCore && swift test
cd ../../mac && xcodebuild test -project MacCaptions.xcodeproj -scheme MacCaptions -destination 'platform=macOS'
```
Expected: all green.

- [ ] **Step 2: Deploy backend** (requires user confirmation for production deploy)

```bash
cd backend && fly deploy
fly secrets unset MAIL_USERNAME MAIL_PASSWORD NOTIFY_EMAIL_TO
```

- [ ] **Step 3: Manual e2e (user-assisted)**

Start MacCaptions, enable both sources, play a video and speak → labeled captions live in the panel; stop → session appears in Transcripts window AND at https://watch-captions-relay.fly.dev/app with Me/Them lines; summary arrives ~30s later. Also run one watch session → still works, unlabeled lines.

- [ ] **Step 4: Update root README** — add a `mac/` bullet describing the app, and note transcripts sync via the relay.

- [ ] **Step 5: Commit + push**

```bash
git add README.md mac/README.md
git commit -m "docs: macOS app usage and cross-device transcript notes"
git push
```
