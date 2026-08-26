# Roaming transcriber Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The iPhone becomes the watch's preferred transcriber over WatchConnectivity — iMac-quality captions anywhere, kept sessions store-and-forwarded through the phone — and the watch's modes collapse to Auto / Watch only.

**Architecture:** A `PhoneEngine: CaptionEngine` on the watch streams PCM over `WCSession` to a `WCTranscriberService` in the PhoneCaptions app, which runs SpeechAnalyzer via a new shared `TranscriberCore` package (extracted from `transcriber-mac`) and replies with caption events. `HybridEngine`'s remote leg is chosen per session (phone → iMac relay → none). Kept sessions hand the phone the watch's bearer token; a `ForwardingStore` queues transcript text on disk and replays the relay's existing `/v1/captions` + `/v1/stop` until delivered. The relay changes not at all.

**Tech Stack:** WatchConnectivity, Speech (SpeechAnalyzer, iOS 26/macOS 26), SwiftUI, XcodeGen, the existing CaptionRelay local package (shared watch+phone code lives there because both targets already depend on it and it has the only Swift test target in the repo).

**Spec:** `docs/superpowers/specs/2026-08-25-roaming-transcriber-design.md`

## Global Constraints

- Transport is WatchConnectivity only; the phone-nearby-nothing-else case must work. Stale live audio is never queued — dropped chunks are dropped; only transcript FORWARDING is queued/reliable.
- Wire protocol messages and mode names exactly as the spec defines them; partials are cumulative (project-wide convention).
- Captions never stall on any remote failure — phone loss lands on `HybridEngine`'s existing `relayDied()` path. Both-engines-dead remains the only session-ending state.
- iOS deployment target rises 17.0 → "26.0" (SpeechAnalyzer floor); watchOS stays 11.0. The iOS upload extension target rises with the app.
- Relay/backend: zero changes. `CaptionRelay` package additions are additive only (new files, no signature changes to existing types).
- Shared logic that needs unit tests goes in the `CaptionRelay` package (its `CaptionRelayTests` is the repo's Swift test home); app targets have no test targets and are verified by build + simulator/device checks.
- Build checks: watch — `cd watch && xcodegen generate && xcodebuild -project WatchCaptions.xcodeproj -scheme WatchCaptions -destination 'generic/platform=watchOS Simulator' CODE_SIGNING_ALLOWED=NO build`; iOS — `cd ios && xcodegen generate && xcodebuild -project PhoneCaptions.xcodeproj -scheme PhoneCaptions -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build`; package — `cd CaptionRelay && swift test`; transcriber — `cd transcriber-mac && swift test`. All must pass at every task's end.
- The tree holds unrelated untracked files (`mac/`, `watch/CaptionCore/`, `*.prod-backup`) — commit only files each task names. Commits: normal prose, conventional prefix, trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Device installs and anything needing the physical watch/iPhone pause for the controller/user; implementers never install on hardware.

---

## File map

| Path | Change |
|---|---|
| `watch/WatchCaptions/SpikeWC.swift` (Task 1, then deleted in Task 5) | throwaway throughput harness, watch side |
| `ios/PhoneCaptions/SpikeWC.swift` (Task 1, then deleted in Task 4) | throwaway harness, phone side |
| `TranscriberCore/` | new local package: `TranscriberSession`, `PCMDecoder`, `WireFormat`, `wavDataChunk` moved from transcriber-mac |
| `transcriber-mac/` | consumes TranscriberCore; loses the moved files; tests move to the package |
| `CaptionRelay/Sources/CaptionRelay/PhoneWire.swift` | wire-protocol codec (pure structs + encode/decode) |
| `CaptionRelay/Sources/CaptionRelay/ForwardQueue.swift` | pure store-and-forward queue logic |
| `CaptionRelay/Tests/CaptionRelayTests/{PhoneWireTests,ForwardQueueTests}.swift` | unit tests |
| `ios/PhoneCaptions/WCTranscriberService.swift` | WCSession delegate → TranscriberSession per watch session |
| `ios/PhoneCaptions/ForwardingStore.swift` | disk-backed queue + URLSession replay to the relay |
| `ios/PhoneCaptions/PhoneCaptionsApp.swift` | service activation |
| `ios/project.yml` | iOS 26, TranscriberCore package |
| `watch/WatchCaptions/PhoneEngine.swift` | the WCSession CaptionEngine |
| `watch/WatchCaptions/HybridEngine.swift` | remote leg becomes injectable |
| `watch/WatchCaptions/AppModel.swift` | Auto probing, two modes, migration |
| `watch/WatchCaptions/Views/HomeView.swift` | two-mode button |

---

### Task 1: Device spike — WCSession audio throughput (go/no-go gate)

**Files:**
- Create: `watch/WatchCaptions/SpikeWC.swift`, `ios/PhoneCaptions/SpikeWC.swift`
- Modify: `watch/WatchCaptions/WatchCaptionsApp.swift` (one call), `ios/PhoneCaptions/PhoneCaptionsApp.swift` (one call)

**Interfaces:** none — throwaway, gated so it never runs in normal use.

- [ ] **Step 1: Watch side.** `SpikeWC.runIfRequested()` called from the app `init`. Gated on a file marker the controller writes into the app container before launching (`Documents/spike-wc` exists → run), NOT an env var (env vars via devicectl were unreliable on this watch — see ParakeetBench's history). When active: activate `WCSession.default` with a minimal delegate; on activation + `isReachable`, stream 60 seconds of synthetic PCM — 240 chunks of 8,000 bytes (0.25 s at 32 KB/s), stamped with sequence + send-time — via `sendMessageData(_:replyHandler:)`, the reply carrying the phone's receive-time and echo of the sequence. Record per-chunk round-trip, drops (no reply in 5 s), and effective throughput. Write results after every chunk (the file-rewrite pattern from ParakeetBench) to `Documents/spike-wc-results.txt` and `tmp/spike-wc-results.txt`.
- [ ] **Step 2: Phone side.** Mirror-image delegate: on `didReceiveMessageData` reply immediately with `{seq, receivedAt}`; also count bytes and write its own running results file (same two container locations, name `spike-wc-phone.txt`).
- [ ] **Step 3: Build checks** (watch + iOS, per Global Constraints). Expected: both BUILD SUCCEEDED.
- [ ] **Step 4: Commit** — `git add watch/WatchCaptions/SpikeWC.swift ios/PhoneCaptions/SpikeWC.swift watch/WatchCaptions/WatchCaptionsApp.swift ios/PhoneCaptions/PhoneCaptionsApp.swift && git commit -m "spike: WatchConnectivity audio-throughput harness (temporary)"`
- [ ] **Step 5: HANDOFF — controller runs the spike on hardware.** Controller: install both apps, write the marker files via `devicectl device copy to`, launch both, wait ~90 s, pull both results files. Go/no-go: sustained ≥ 32 KB/s with median RTT ≤ 500 ms and drop rate ≤ 2% → GO. Marginal (RTT ≤ 1 s) → GO with a note that chunk size should rise to 0.5 s. Worse → STOP, redesign transport before Task 3+ (Tasks 2 is transport-independent and may proceed regardless).

---

### Task 2: TranscriberCore package extraction

**Files:**
- Create: `TranscriberCore/Package.swift`, `TranscriberCore/Sources/TranscriberCore/{TranscriberSession.swift,PCMDecoder.swift,WavData.swift}`, `TranscriberCore/Tests/TranscriberCoreTests/{PCMDecoderTests.swift,WavDataChunkTests.swift}`
- Modify: `transcriber-mac/Package.swift`, `transcriber-mac/Sources/caption-transcriber/{main.swift,WebSocketServer.swift}` (imports), delete the moved sources/tests from transcriber-mac

**Interfaces:**
- Produces: package `TranscriberCore`, platforms `[.iOS("26.0"), .macOS("26.0")]`, exporting `public actor TranscriberSession` (`init(locale: Locale, format: WireFormat) async throws`, `nonisolated func feed(_ data: Data)`, `func finish() async`, `let events: AsyncStream<Event>` with `Event.ready/.transcript(text:isFinal:)/.error(String)`, `static func ensureModel(locale: Locale) async throws`), `public enum WireFormat: String { case pcm16k, mulaw8k }`, `public struct PCMDecoder`, `public func wavDataChunk(_ wav: Data) -> Data?`. Access levels rise from internal to public with explicit `public init`s where needed; NO behavioral changes — this is a move.

- [ ] **Step 1: Package.swift**

```swift
// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "TranscriberCore",
    platforms: [.iOS("26.0"), .macOS("26.0")],
    products: [.library(name: "TranscriberCore", targets: ["TranscriberCore"])],
    targets: [
        .target(name: "TranscriberCore"),
        .testTarget(name: "TranscriberCoreTests", dependencies: ["TranscriberCore"]),
    ],
    swiftLanguageModes: [.v5]
)
```

- [ ] **Step 2: Move** `TranscriberSession.swift`, `PCMDecoder.swift` and the `wavDataChunk` function (extract it from `main.swift` into `WavData.swift`) from `transcriber-mac/Sources/caption-transcriber/` into the package; move `PCMDecoderTests.swift` + `WavDataChunkTests.swift` likewise. Add `public` as the Interfaces block specifies. `transcriber-mac/Package.swift` gains `.package(path: "../TranscriberCore")` and the target depends on the product; remaining files `import TranscriberCore`.
- [ ] **Step 3: Verify** — `cd TranscriberCore && swift test` (the moved unit tests pass), `cd transcriber-mac && swift test && swift build` (its remaining tests and the executable still build), and the sidecar still works: `swift run caption-transcriber --file /tmp/hello.wav` (copy `~/Projects/moonshine-coreml/test-assets/hello.wav` to `/tmp` if absent) prints the exact final "Hello, this is a test of captions running on the watch."
- [ ] **Step 4: Commit** — `git add TranscriberCore transcriber-mac && git commit -m "refactor: extract TranscriberCore so the phone and Mac share one SpeechAnalyzer implementation"`

---

### Task 3: Wire-protocol codec in CaptionRelay

**Files:**
- Create: `CaptionRelay/Sources/CaptionRelay/PhoneWire.swift`
- Test: `CaptionRelay/Tests/CaptionRelayTests/PhoneWireTests.swift`

**Interfaces:**
- Produces (exact):

```swift
public enum PhoneWire {
    public struct Begin: Codable, Equatable {
        public let sessionId: String
        public let keep: Bool
        public let token: String?      // present only when keep
        public init(sessionId: String, keep: Bool, token: String?)
    }
    public struct Audio: Equatable {
        public let seq: Int
        public let pcm: Data
        public init(seq: Int, pcm: Data)
    }
    public struct Caption: Codable, Equatable {
        public let text: String
        public let isFinal: Bool
        public init(text: String, isFinal: Bool)
    }
    public enum Message: Equatable {
        case begin(Begin)
        case audio(Audio)
        case finish
        case ready
        case caption(Caption)
        case error(String)
    }
    public static func encode(_ message: Message) -> Data
    public static func decode(_ data: Data) -> Message?
}
```

Encoding: byte 0 is a type tag (1 begin, 2 audio, 3 finish, 4 ready, 5 caption, 6 error); for begin/caption/error the rest is JSON; for audio, bytes 1–8 are the little-endian Int64 seq and the remainder is raw PCM (no JSON on the hot path).

- [ ] **Step 1: Failing tests** — round-trip every case (begin with and without token; audio with a seq > 2^31 and 8 KB payload byte-identical; finish/ready as 1-byte messages; caption partial+final; error), and `decode` returning nil on: empty data, unknown tag, truncated audio header, malformed JSON.
- [ ] **Step 2: Run, verify FAIL** — `cd CaptionRelay && swift test --filter PhoneWireTests` fails: PhoneWire undefined.
- [ ] **Step 3: Implement** per the interface. JSON via `JSONEncoder`/`JSONDecoder`; the audio path uses `withUnsafeBytes`/manual little-endian assembly.
- [ ] **Step 4: Run, verify PASS** — full `swift test` in CaptionRelay stays green (133 existing + new).
- [ ] **Step 5: Commit** — `git add CaptionRelay && git commit -m "feat(relay-kit): wire codec for the watch-phone transcription channel"`

---

### Task 4: iPhone transcriber service

**Files:**
- Create: `ios/PhoneCaptions/WCTranscriberService.swift`
- Modify: `ios/project.yml` (deploymentTarget iOS "26.0"; add `TranscriberCore` package + product to the app target), `ios/PhoneCaptions/PhoneCaptionsApp.swift` (hold + activate the service), delete `ios/PhoneCaptions/SpikeWC.swift` and its app-init call
- (No unit-test file: WCSession is not unit-testable; the service's logic is thin routing over tested components.)

**Interfaces:**
- Consumes: `TranscriberCore.TranscriberSession` (Task 2 signatures), `PhoneWire` (Task 3).
- Produces: `final class WCTranscriberService: NSObject, WCSessionDelegate` — singleton `WCTranscriberService.shared`, `func activate()`. Also consumed by Task 6: `var onKeptSessionEvent: ((KeptEvent) -> Void)?` where `enum KeptEvent { case line(sessionId: String, token: String, caption: PhoneWire.Caption); case finished(sessionId: String, token: String) }` — fired for kept sessions only, on an internal serial queue.

- [ ] **Step 1: Implement.** `activate()` sets `WCSession.default.delegate = self; activate()`. On `didReceiveMessageData` decode via `PhoneWire.decode`:
  - `begin`: tear down any existing session for a DIFFERENT sessionId (one at a time, newest wins), create `Task { TranscriberSession(locale: en-US, format: .pcm16k) }` after `ensureModel` once per process; pump its `events` → `PhoneWire.encode(.ready/.caption/.error)` sent back via `session.sendMessageData(_:replyHandler:nil)`; remember `keep`/`token`; for kept sessions also fire `onKeptSessionEvent(.line(...))` for every FINAL caption.
  - `audio`: `transcriber.feed(pcm)` (drop silently when no session — a `begin` was lost; the watch's next session re-begins).
  - `finish`: `await session.finish()` (drains the last final through the same event pump), then fire `.finished`, drop state.
  - Decode failures: ignore the message.
  All state confined to one serial DispatchQueue; the WCSession delegate callbacks hop onto it.
- [ ] **Step 2: project.yml + app gutting (user-directed scope, 2026-08-25)** — deploymentTarget iOS "26.0"; packages gains `TranscriberCore: {path: ../TranscriberCore}`; app target dependencies gain the product. Delete the spike file + call. ALSO REMOVE: the broadcast screen and its flow (the watch-side reader was deleted long ago), the speech-provider picker, the "open iPhone audio automatically" toggle, the "save transcripts" toggle, the caption-text-size setting, the settings-sync plumbing behind them (SettingsModel/SettingsView shrink or vanish), the PairingView (pairing is not reinstated; identity arrives in Task 8 via WC token share), and the ENTIRE PhoneCaptionsUpload share-sheet extension (target, sources, entitlement wiring). What remains after this task: the app shell + WCTranscriberService and a minimal transcriber-status view (state: waiting/transcribing, sessions served). Delete dead files; grep for orphans.
- [ ] **Step 3: Build check** (iOS, per Global Constraints) — BUILD SUCCEEDED.
- [ ] **Step 4: Commit** — `git add ios TranscriberCore 2>/dev/null; git add ios && git commit -m "feat(ios): on-phone SpeechAnalyzer transcription service for the watch"`

---

### Task 5: PhoneEngine and Auto mode on the watch

**Files:**
- Create: `watch/WatchCaptions/PhoneEngine.swift`
- Modify: `watch/WatchCaptions/HybridEngine.swift` (remote leg injectable), `watch/WatchCaptions/AppModel.swift` (probe + two modes + migration), `watch/WatchCaptions/Views/HomeView.swift` (two-mode button), delete `watch/WatchCaptions/SpikeWC.swift` + its app-init call

**Interfaces:**
- Consumes: `PhoneWire` (CaptionRelay package — the watch target already links it), `CaptionEngine` protocol.
- Produces: `final class PhoneEngine: NSObject, CaptionEngine, WCSessionDelegate` with `var mode: SessionMode` (same contract as `HTTPRelayClient.mode` — `.saved` sessions send `keep=true` + the bearer token in `begin`; the token is fetched via the same provider closure `AppModel` hands every client), `var onTranscript: (@MainActor (String) -> Void)?` may remain unimplemented/nil-firing (phone sessions name no transcript for the watch; history attribution arrives via forwarding — document this in a doc comment). `HybridEngine.init` gains `remote: CaptionEngine & AnyObject` replacing its internally-constructed relay client; `AppModel.CaptureMode` becomes `enum CaptureMode: String { case auto, watchOnly }`.

- [ ] **Step 1: PhoneEngine.** `start()`: activate WCSession (idempotent), send `begin` (fetching the token first when `.saved` — the same async provider dance `HTTPRelayClient.flush` does), then emit nothing until the phone's `ready` arrives (the HYBRID's local leg provides the instant `.ready` — PhoneEngine is only ever a remote leg, mirror how `HTTPRelayClient` behaves inside the hybrid). `send(_:)`: while `isReachable`, `PhoneWire.encode(.audio(...))` via `sendMessageData` with an incrementing seq; drop when unreachable (never queue). Incoming `caption`/`error` map to `.caption`/`.error` events; `error` and reachability loss (`sessionReachabilityDidChange` to false, or a send error after 3 consecutive failures) fire `onClose` — the hybrid's existing remote-death path. `close()`: send `finish`, keep the delegate alive briefly (5 s timer) so the last final can still arrive, then detach.
- [ ] **Step 2: HybridEngine** — replace the internal `HTTPRelayClient` construction with an injected `remote: CaptionEngine` (the existing `localEnabled` cloud trick and all arbitration untouched — it only ever spoke to the remote through the `CaptionEngine` surface; verify that claim while editing and note any leak of concrete type).
- [ ] **Step 3: AppModel** — `CaptureMode.auto/.watchOnly`, migration in `init` (old raw values: `"local"` → `.watchOnly`; `"cloud"`/`"hybrid"` → `.auto`; unknown → `.auto`). Auto session start probes: `WCSession.default.isReachable` → `HybridEngine(remote: PhoneEngine(...))`; else → `HybridEngine(remote: HTTPRelayClient(...))` (today's behavior); the hybrid's own degrade covers everything after the probe. Watch-only path untouched. `retry()` re-probes (a retry may pick a different remote — that is the point).
- [ ] **Step 4: HomeView** — the button toggles two states: `Label("Auto", systemImage: "wand.and.stars")` / `Label("Watch only", systemImage: "applewatch")`, hints updated.
- [ ] **Step 5: Build check** (watch) — BUILD SUCCEEDED. Delete the spike file first.
- [ ] **Step 6: Commit** — `git add watch/WatchCaptions && git commit -m "feat(watch): the phone is Auto mode's preferred transcriber"`

---

### Task 6: ForwardingStore on the phone

**Files:**
- Create: `CaptionRelay/Sources/CaptionRelay/ForwardQueue.swift`, `CaptionRelay/Tests/CaptionRelayTests/ForwardQueueTests.swift`, `ios/PhoneCaptions/ForwardingStore.swift`
- Modify: `ios/PhoneCaptions/PhoneCaptionsApp.swift` (wire service → store)

**Interfaces:**
- Consumes: `WCTranscriberService.onKeptSessionEvent` (Task 4), `PhoneWire.Caption`.
- Produces (pure logic, package):

```swift
/// Disk-format-owning queue of kept-session lines awaiting delivery.
/// Storage-agnostic: callers hand it load/save closures, tests use memory.
public struct ForwardQueue: Codable, Equatable {
    public struct Entry: Codable, Equatable {
        public let sessionId: String
        public let token: String
        public var lines: [PhoneWire.Caption]
        public var finished: Bool
    }
    public private(set) var entries: [Entry]
    public init()
    public mutating func append(sessionId: String, token: String, caption: PhoneWire.Caption)
    public mutating func markFinished(sessionId: String, token: String)
    /// The first entry ready to deliver (finished, or holding ≥ batchThreshold lines).
    public func nextDeliverable(batchThreshold: Int) -> Entry?
    /// Remove delivered lines/entry after a successful replay.
    public mutating func delivered(sessionId: String, lineCount: Int, finished: Bool)
}
```

- [ ] **Step 1: Failing tests** — append/order preservation across sessions; markFinished; nextDeliverable honors threshold and finished-first; delivered removes exactly what was sent and drops the entry (token included) once finished+empty; Codable round-trip byte-stable.
- [ ] **Step 2: FAIL, implement, PASS** — `cd CaptionRelay && swift test` green.
- [ ] **Step 3: ForwardingStore (iOS).** Owns a `ForwardQueue` persisted as JSON in the app container (`Application Support/forward-queue.json`, atomic writes, load on init). Subscribes to `WCTranscriberService.onKeptSessionEvent`. A delivery loop (retriggered on append, on `finished`, on app foreground, and by a 60 s timer) takes `nextDeliverable(batchThreshold: 10)` and replays it against the relay: `POST {relayURL}/v1/captions?session=<sessionId>` with `{"lines":[{"text","isFinal"}...]}` and `Authorization: Bearer <token>`; when the entry is finished and empty after delivery, `POST /v1/stop?session=<sessionId>`. On success `delivered(...)` + persist; on any failure, back off (60 s) and leave the queue untouched. The relay base URL comes from `ios/Shared/Secrets.swift`'s existing `relayURL`.
- [ ] **Step 4: Build check** (iOS) — BUILD SUCCEEDED.
- [ ] **Step 5: Commit** — `git add CaptionRelay ios && git commit -m "feat(ios): store-and-forward delivery of kept phone-transcribed sessions"`

---

### Task 7: Paired-simulator end-to-end and docs

**Files:**
- Modify: `watch/README.md`, `README.md`, `ios/README.md` (roaming architecture, modes, forwarding)

- [ ] **Step 1: Paired sim run.** `xcrun simctl list pairs` — use (or create with `xcrun simctl pair`) a watch+phone simulator pair; boot both; install the watch app on the watch sim and PhoneCaptions on the phone sim; launch both. Start an Auto session on the watch sim with Keep on; play speech on the Mac (`say` aloud near the mic, or `afplay` of `~/Projects/moonshine-coreml/test-assets/hello.wav` at volume) and verify: captions appear on the watch sim (screenshot), and within ~2 min the transcript shows up on the relay (`curl` the transcripts list on imac with a dev token, or check the training/viewer page) — proving WC transport + phone transcription + forwarding end to end in simulators. Record every command and artifact.
- [ ] **Step 2: Docs** — watch README: the two modes and what Auto prefers; ios README: the transcriber service + forwarding; root README: the roaming architecture sentence and updated component diagram line.
- [ ] **Step 3: Commit** — `git add watch/README.md ios/README.md README.md && git commit -m "docs: roaming transcriber — modes, phone service, forwarding"`
- [ ] **Step 4: HANDOFF — hardware verification (controller + user):** install both apps on the physical devices; user tests: (a) Auto at home (should still prefer phone), (b) Auto with Wi-Fi off on both, walking away from the Mac — captions continue via Bluetooth; (c) a kept session with the phone in Airplane-mode-except-Bluetooth, then re-enable data and confirm the transcript lands on the iMac minutes later; (d) Watch only sanity.

---

### Task 8: Transcripts & summaries on the phone

**Files:**
- Create: `ios/PhoneCaptions/TranscriptsListView.swift`, `ios/PhoneCaptions/TranscriptDetailView.swift`, `ios/PhoneCaptions/WatchIdentityStore.swift`
- Modify: `CaptionRelay/Sources/CaptionRelay/PhoneWire.swift` (+ `shareIdentity` message), `CaptionRelay/Tests/CaptionRelayTests/PhoneWireTests.swift`, `watch/WatchCaptions/PhoneEngine.swift` (send shareIdentity on counterpart connect), `ios/PhoneCaptions/WCTranscriberService.swift` (receive + store), `ios/PhoneCaptions/PhoneCaptionsApp.swift` (tab/navigation)

**Interfaces:**
- Consumes: `RelayHistoryClient` (CaptionRelay package — the same client the watch uses for history/detail), `PhoneWire`, the keychain pattern from `KeychainTokenStore` (CaptionRelayLive).
- Produces: `PhoneWire.Message.shareIdentity(token: String)` (tag 7; JSON body `{"token":...}`); `WatchIdentityStore` — keychain-backed store of the watch's bearer token on the phone (`read() -> String?`, `write(_:)`, `clear()`), service-named distinctly from the phone's own identity.

- [ ] **Step 1: PhoneWire.shareIdentity** — failing round-trip + malformed-decode tests, implement, `swift test` green in CaptionRelay.
- [ ] **Step 2: Watch sends it** — in `PhoneEngine`, on activation with a reachable counterpart (and once per app launch at most), fetch the token via the existing provider closure and send `shareIdentity`. Failures are silent (identity share is opportunistic; the next launch retries).
- [ ] **Step 3: Phone stores it** — `WCTranscriberService` routes `shareIdentity` to `WatchIdentityStore.write`. Keychain via the `KeychainTokenStore` pattern with its own service string.
- [ ] **Step 4: The screens** — `TranscriptsListView`: sessions newest-first via `RelayHistoryClient` (constructed with `Secrets.relayURL` + a token provider reading `WatchIdentityStore`); empty state explains captions must run once near the phone to link. `TranscriptDetailView`: transcript text + the summary the relay holds for it (whatever the history client's detail exposes — reuse, do not invent endpoints). Pull-to-refresh. Read-only. App navigation: two tabs — Transcriber (status view), Transcripts.
- [ ] **Step 5: Build checks** (iOS + watch + CaptionRelay tests) all green; sim screenshot of the list with the empty state.
- [ ] **Step 6: Commit** — `git add CaptionRelay ios watch/WatchCaptions && git commit -m "feat(ios): transcripts and summaries reader, linked over WatchConnectivity"`

---

## Self-review notes

- Spec coverage: transport + protocol (T1, T3), TranscriberCore (T2), phone service (T4), watch engine/modes/migration (T5), forwarding + auth (T6), verification + docs (T7). Relay untouched throughout — matches "zero changes". The spike gate implements the spec's Verification section.
- Interfaces named identically across tasks: `PhoneWire` (T3→T4,T5,T6), `TranscriberSession` signatures (T2→T4), `onKeptSessionEvent`/`KeptEvent` (T4→T6), `CaptureMode.auto/.watchOnly` (T5 only).
- The known WC risk is front-loaded as Task 1 with explicit go/no-go thresholds; Task 2 is transport-independent and survives a STOP.
- Amendments 2026-08-25 (user-directed): Task 4 scope grew into the full phone-app gutting (broadcast, settings/toggles, pairing UI, share extension); Task 8 added (transcripts & summaries reader + WC identity share). Both recorded in the SDD ledger with rulings.
