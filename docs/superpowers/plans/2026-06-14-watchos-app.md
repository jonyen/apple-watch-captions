# watchOS Live-Caption App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the standalone watchOS app that streams Watch-mic audio to the live relay and renders live captions, per `docs/superpowers/specs/2026-06-14-watchos-app-design.md`.

**Architecture:** Pure logic (`ServerMessage`, `CaptionStore`, `SessionController`, protocols) lives in a local Swift package **`CaptionCore`**, unit-tested with `swift test` on macOS — fast and deterministic, no simulator. The watchOS app (scaffolded by **XcodeGen**) depends on `CaptionCore` and supplies the platform pieces (`RelayClient` over `URLSessionWebSocketTask`, `AudioCapture` over `AVAudioEngine`, `MicPermission`, SwiftUI views, `@main` app driving start/stop off `scenePhase`). Listening runs whenever the app is active; no buttons.

**Tech Stack:** Swift 5.9 / SwiftPM, Combine, SwiftUI, AVFoundation, XcodeGen, Xcode 26.

**Protocol contract (the relay — see `backend/README.md`):**
- Connect `wss://<host>/stream?token=<AUTH_TOKEN>`; send binary PCM frames (16-bit LE, 16 kHz, mono); wait for `{"type":"ready"}` before sending audio.
- Inbound JSON: `{"type":"ready"}`, `{"type":"caption","text":"…","isFinal":bool}`, `{"type":"error","message":"…"}`.
- Live relay: `wss://watch-captions-relay.fly.dev/stream`. The auth token is in `/tmp/auth.token` (and the Fly secret) — never commit it.

**Directory:** everything under `watch/`.

---

### Task 1: Scaffold the `CaptionCore` Swift package

**Files:**
- Create: `watch/CaptionCore/Package.swift`
- Create: `watch/CaptionCore/Sources/CaptionCore/Placeholder.swift`
- Create: `watch/CaptionCore/Tests/CaptionCoreTests/SmokeTest.swift`

- [ ] **Step 1: Create `watch/CaptionCore/Package.swift`**

```swift
// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CaptionCore",
    platforms: [.watchOS(.v10), .iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "CaptionCore", targets: ["CaptionCore"]),
    ],
    targets: [
        .target(name: "CaptionCore"),
        .testTarget(name: "CaptionCoreTests", dependencies: ["CaptionCore"]),
    ]
)
```

- [ ] **Step 2: Create a placeholder so the target compiles**

`watch/CaptionCore/Sources/CaptionCore/Placeholder.swift`:
```swift
// Replaced by real types in later tasks.
enum CaptionCorePlaceholder {}
```

- [ ] **Step 3: Create a smoke test**

`watch/CaptionCore/Tests/CaptionCoreTests/SmokeTest.swift`:
```swift
import XCTest

final class SmokeTest: XCTestCase {
    func testToolchainRuns() {
        XCTAssertTrue(true)
    }
}
```

- [ ] **Step 4: Verify `swift test` runs**

Run: `cd watch/CaptionCore && swift test`
Expected: builds and runs; 1 test passes.

- [ ] **Step 5: Commit**

```bash
git add watch/CaptionCore
git commit -m "chore: scaffold CaptionCore swift package"
```

---

### Task 2: `ServerMessage` decoding (TDD)

**Files:**
- Create: `watch/CaptionCore/Sources/CaptionCore/ServerMessage.swift`
- Test: `watch/CaptionCore/Tests/CaptionCoreTests/ServerMessageTests.swift`
- Delete: `watch/CaptionCore/Sources/CaptionCore/Placeholder.swift` (no longer needed once real types exist)

- [ ] **Step 1: Write the failing test**

`watch/CaptionCore/Tests/CaptionCoreTests/ServerMessageTests.swift`:
```swift
import XCTest
@testable import CaptionCore

final class ServerMessageTests: XCTestCase {
    private func decode(_ json: String) throws -> ServerMessage {
        try ServerMessage.decode(Data(json.utf8))
    }

    func testDecodesReady() throws {
        XCTAssertEqual(try decode(#"{"type":"ready"}"#), .ready)
    }

    func testDecodesPartialCaption() throws {
        XCTAssertEqual(
            try decode(#"{"type":"caption","text":"hello","isFinal":false}"#),
            .caption(text: "hello", isFinal: false)
        )
    }

    func testDecodesFinalCaption() throws {
        XCTAssertEqual(
            try decode(#"{"type":"caption","text":"hello world","isFinal":true}"#),
            .caption(text: "hello world", isFinal: true)
        )
    }

    func testDecodesError() throws {
        XCTAssertEqual(
            try decode(#"{"type":"error","message":"boom"}"#),
            .error(message: "boom")
        )
    }

    func testThrowsOnUnknownType() {
        XCTAssertThrowsError(try decode(#"{"type":"weird"}"#))
    }
}
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `cd watch/CaptionCore && swift test --filter ServerMessageTests`
Expected: FAIL — `ServerMessage` not found.

- [ ] **Step 3: Implement `ServerMessage` and remove the placeholder**

Delete `watch/CaptionCore/Sources/CaptionCore/Placeholder.swift`. Create `watch/CaptionCore/Sources/CaptionCore/ServerMessage.swift`:
```swift
import Foundation

/// A message received from the caption relay.
public enum ServerMessage: Equatable {
    case ready
    case caption(text: String, isFinal: Bool)
    case error(message: String)
}

extension ServerMessage: Decodable {
    private enum CodingKeys: String, CodingKey { case type, text, isFinal, message }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .type) {
        case "ready":
            self = .ready
        case "caption":
            self = .caption(
                text: try c.decode(String.self, forKey: .text),
                isFinal: try c.decode(Bool.self, forKey: .isFinal)
            )
        case "error":
            self = .error(message: try c.decode(String.self, forKey: .message))
        case let other:
            throw DecodingError.dataCorruptedError(
                forKey: .type, in: c, debugDescription: "unknown message type \(other)")
        }
    }
}

public extension ServerMessage {
    /// Decode a UTF-8 JSON payload from the relay.
    static func decode(_ data: Data) throws -> ServerMessage {
        try JSONDecoder().decode(ServerMessage.self, from: data)
    }
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `cd watch/CaptionCore && swift test --filter ServerMessageTests`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add watch/CaptionCore
git commit -m "feat: add ServerMessage decoding"
```

---

### Task 3: `CaptionStore` state + `apply` (TDD)

**Files:**
- Create: `watch/CaptionCore/Sources/CaptionCore/CaptionStore.swift`
- Test: `watch/CaptionCore/Tests/CaptionCoreTests/CaptionStoreTests.swift`

- [ ] **Step 1: Write the failing test**

`watch/CaptionCore/Tests/CaptionCoreTests/CaptionStoreTests.swift`:
```swift
import XCTest
@testable import CaptionCore

@MainActor
final class CaptionStoreTests: XCTestCase {
    func testStartsConnecting() {
        XCTAssertEqual(CaptionStore().state, .connecting)
    }

    func testReadyMovesToListening() {
        let s = CaptionStore()
        s.apply(.ready)
        XCTAssertEqual(s.state, .listening)
    }

    func testPartialSetsPartialLine() {
        let s = CaptionStore()
        s.apply(.caption(text: "hel", isFinal: false))
        XCTAssertEqual(s.partial, "hel")
        XCTAssertTrue(s.lines.isEmpty)
    }

    func testFinalAppendsAndClearsPartial() {
        let s = CaptionStore()
        s.apply(.caption(text: "hel", isFinal: false))
        s.apply(.caption(text: "hello", isFinal: true))
        XCTAssertEqual(s.lines, ["hello"])
        XCTAssertEqual(s.partial, "")
    }

    func testEmptyFinalIsNotAppended() {
        let s = CaptionStore()
        s.apply(.caption(text: "", isFinal: true))
        XCTAssertTrue(s.lines.isEmpty)
    }

    func testErrorSetsErrorState() {
        let s = CaptionStore()
        s.apply(.error(message: "boom"))
        XCTAssertEqual(s.state, .error("boom"))
    }

    func testResetClearsEverything() {
        let s = CaptionStore()
        s.apply(.caption(text: "hi", isFinal: true))
        s.apply(.ready)
        s.reset()
        XCTAssertTrue(s.lines.isEmpty)
        XCTAssertEqual(s.partial, "")
        XCTAssertEqual(s.state, .connecting)
    }

    func testSetErrorSetsErrorState() {
        let s = CaptionStore()
        s.setError("Connection lost")
        XCTAssertEqual(s.state, .error("Connection lost"))
    }
}
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `cd watch/CaptionCore && swift test --filter CaptionStoreTests`
Expected: FAIL — `CaptionStore` / `CaptionState` not found.

- [ ] **Step 3: Implement**

`watch/CaptionCore/Sources/CaptionCore/CaptionStore.swift`:
```swift
import Foundation
import Combine

/// The screen the app shows, derived from session progress.
public enum CaptionState: Equatable {
    case connecting
    case listening
    case error(String)
}

/// Observable transcript + connection state. UI state only; mutate on the main actor.
@MainActor
public final class CaptionStore: ObservableObject {
    @Published public private(set) var lines: [String] = []
    @Published public private(set) var partial: String = ""
    @Published public private(set) var state: CaptionState = .connecting

    public init() {}

    /// Fold a relay message into the transcript/state.
    public func apply(_ message: ServerMessage) {
        switch message {
        case .ready:
            state = .listening
        case .caption(let text, let isFinal):
            if isFinal {
                if !text.isEmpty { lines.append(text) }
                partial = ""
            } else {
                partial = text
            }
        case .error(let message):
            state = .error(message)
        }
    }

    /// Clear the transcript and return to connecting (called at session start).
    public func reset() {
        lines = []
        partial = ""
        state = .connecting
    }

    /// Force an error state (e.g. connection lost, permission denied).
    public func setError(_ message: String) {
        state = .error(message)
    }
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `cd watch/CaptionCore && swift test --filter CaptionStoreTests`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add watch/CaptionCore
git commit -m "feat: add CaptionStore transcript state"
```

---

### Task 4: Protocols + `SessionController` orchestration (TDD)

**Files:**
- Create: `watch/CaptionCore/Sources/CaptionCore/Protocols.swift`
- Create: `watch/CaptionCore/Sources/CaptionCore/SessionController.swift`
- Test: `watch/CaptionCore/Tests/CaptionCoreTests/SessionControllerTests.swift`

- [ ] **Step 1: Define the protocols**

`watch/CaptionCore/Sources/CaptionCore/Protocols.swift`:
```swift
import Foundation

/// Transport to the caption relay. Callbacks are delivered on the main actor.
public protocol Relay: AnyObject {
    var onMessage: (@MainActor (ServerMessage) -> Void)? { get set }
    var onClose: (@MainActor () -> Void)? { get set }
    func connect()
    func send(_ audio: Data)
    func close()
}

/// Microphone capture producing 16 kHz mono Int16 PCM chunks.
/// `onChunk` may be called on a background (audio) thread.
public protocol AudioCapturing: AnyObject {
    func start(onChunk: @escaping (Data) -> Void) throws
    func stop()
}

/// Microphone permission gate.
public protocol MicPermissionProviding {
    func ensureGranted() async -> Bool
}
```

- [ ] **Step 2: Write the failing test (with fakes)**

`watch/CaptionCore/Tests/CaptionCoreTests/SessionControllerTests.swift`:
```swift
import XCTest
@testable import CaptionCore

@MainActor
final class SessionControllerTests: XCTestCase {

    final class FakeRelay: Relay {
        var onMessage: (@MainActor (ServerMessage) -> Void)?
        var onClose: (@MainActor () -> Void)?
        var connected = false
        var closed = false
        var sent: [Data] = []
        func connect() { connected = true }
        func send(_ audio: Data) { sent.append(audio) }
        func close() { closed = true }
        func deliver(_ m: ServerMessage) { onMessage?(m) }
        func dropConnection() { onClose?() }
    }

    final class FakeAudio: AudioCapturing {
        var started = false
        var stopped = false
        var chunkSink: ((Data) -> Void)?
        func start(onChunk: @escaping (Data) -> Void) throws { started = true; chunkSink = onChunk }
        func stop() { stopped = true }
    }

    struct FakePermission: MicPermissionProviding {
        let granted: Bool
        func ensureGranted() async -> Bool { granted }
    }

    private func make(granted: Bool = true)
        -> (SessionController, CaptionStore, FakeRelay, FakeAudio) {
        let store = CaptionStore()
        let relay = FakeRelay()
        let audio = FakeAudio()
        let c = SessionController(store: store, relay: relay, audio: audio,
                                  permission: FakePermission(granted: granted))
        return (c, store, relay, audio)
    }

    func testStartConnectsWhenPermitted() async {
        let (c, store, relay, _) = make()
        await c.start()
        XCTAssertTrue(relay.connected)
        XCTAssertEqual(store.state, .connecting)
    }

    func testStartFailsWhenPermissionDenied() async {
        let (c, store, relay, _) = make(granted: false)
        await c.start()
        XCTAssertFalse(relay.connected)
        if case .error = store.state {} else { XCTFail("expected error state") }
    }

    func testReadyStartsAudioAndListening() async {
        let (c, store, relay, audio) = make()
        await c.start()
        relay.deliver(.ready)
        XCTAssertEqual(store.state, .listening)
        XCTAssertTrue(audio.started)
    }

    func testAudioChunksAreSent() async {
        let (c, _, relay, audio) = make()
        await c.start()
        relay.deliver(.ready)
        audio.chunkSink?(Data([1, 2, 3]))
        XCTAssertEqual(relay.sent, [Data([1, 2, 3])])
    }

    func testCaptionUpdatesStore() async {
        let (c, store, relay, _) = make()
        await c.start()
        relay.deliver(.ready)
        relay.deliver(.caption(text: "hi", isFinal: true))
        XCTAssertEqual(store.lines, ["hi"])
    }

    func testRelayErrorStopsAndShowsError() async {
        let (c, store, relay, audio) = make()
        await c.start()
        relay.deliver(.ready)
        relay.deliver(.error(message: "boom"))
        XCTAssertEqual(store.state, .error("boom"))
        XCTAssertTrue(audio.stopped)
        XCTAssertTrue(relay.closed)
    }

    func testUnexpectedCloseShowsConnectionLost() async {
        let (c, store, relay, audio) = make()
        await c.start()
        relay.deliver(.ready)
        relay.dropConnection()
        XCTAssertEqual(store.state, .error("Connection lost"))
        XCTAssertTrue(audio.stopped)
    }

    func testStopTearsDown() async {
        let (c, _, relay, audio) = make()
        await c.start()
        c.stop()
        XCTAssertTrue(audio.stopped)
        XCTAssertTrue(relay.closed)
    }
}
```

- [ ] **Step 3: Run it — expect FAIL**

Run: `cd watch/CaptionCore && swift test --filter SessionControllerTests`
Expected: FAIL — `SessionController` not found.

- [ ] **Step 4: Implement**

`watch/CaptionCore/Sources/CaptionCore/SessionController.swift`:
```swift
import Foundation

/// Orchestrates a listening session: permission → connect → wait `ready` → stream audio.
/// Wires relay messages into the store and audio chunks into the relay.
@MainActor
public final class SessionController {
    private let store: CaptionStore
    private let relay: Relay
    private let audio: AudioCapturing
    private let permission: MicPermissionProviding
    private var running = false

    public init(store: CaptionStore, relay: Relay,
                audio: AudioCapturing, permission: MicPermissionProviding) {
        self.store = store
        self.relay = relay
        self.audio = audio
        self.permission = permission
        self.relay.onMessage = { [weak self] message in self?.handle(message) }
        self.relay.onClose = { [weak self] in self?.handleClose() }
    }

    /// Begin a session. Safe to call repeatedly; no-op if already running.
    public func start() async {
        guard !running else { return }
        running = true
        store.reset()
        guard await permission.ensureGranted() else {
            store.setError("Microphone access is off. Enable it in Settings › Privacy.")
            running = false
            return
        }
        guard running else { return }   // stopped during the await
        relay.connect()
    }

    /// End the session and tear down audio + transport.
    public func stop() {
        guard running else { return }
        running = false
        audio.stop()
        relay.close()
    }

    private func handle(_ message: ServerMessage) {
        store.apply(message)
        switch message {
        case .ready: startAudio()
        case .error: stop()
        case .caption: break
        }
    }

    private func handleClose() {
        guard running else { return }
        running = false
        store.setError("Connection lost")
        audio.stop()
    }

    private func startAudio() {
        let relay = self.relay   // capture directly; onChunk runs off the main actor
        do {
            try audio.start(onChunk: { data in relay.send(data) })
        } catch {
            store.setError("Microphone error")
            stop()
        }
    }
}
```

- [ ] **Step 5: Run it — expect PASS**

Run: `cd watch/CaptionCore && swift test --filter SessionControllerTests`
Expected: PASS — 8 tests.

- [ ] **Step 6: Run the whole package suite**

Run: `cd watch/CaptionCore && swift test`
Expected: PASS — all tests (smoke + ServerMessage + CaptionStore + SessionController).

- [ ] **Step 7: Commit**

```bash
git add watch/CaptionCore
git commit -m "feat: add SessionController orchestration with protocol seams"
```

---

### Task 5: Scaffold the watchOS app (XcodeGen) depending on CaptionCore

The app target won't have unit tests (device/manual). This task produces a **building** watch app
skeleton that links `CaptionCore`. Some watchOS target settings are finicky — if `xcodegen` or
`xcodebuild` reports a config error, fix the setting and re-run; the goal state is "builds for the
watchOS simulator."

**Files:**
- Create: `watch/project.yml`
- Create: `watch/WatchCaptions/Info.plist`
- Create: `watch/WatchCaptions/WatchCaptionsApp.swift`
- Create: `watch/WatchCaptions/Secrets.example.swift`
- Create: `watch/WatchCaptions/Secrets.swift` (gitignored)
- Create/append: `.gitignore`

- [ ] **Step 1: Gitignore generated project + secrets**

Append to the repo-root `.gitignore`:
```
# watchOS app
watch/*.xcodeproj
watch/WatchCaptions/Secrets.swift
watch/CaptionCore/.build/
```

- [ ] **Step 2: Create `watch/project.yml`**

```yaml
name: WatchCaptions
options:
  bundleIdPrefix: com.jonyen.watchcaptions
  deploymentTarget:
    watchOS: "10.0"
packages:
  CaptionCore:
    path: CaptionCore
targets:
  WatchCaptions:
    type: application
    platform: watchOS
    sources:
      - path: WatchCaptions
    dependencies:
      - package: CaptionCore
    info:
      path: WatchCaptions/Info.plist
      properties:
        WKApplication: true
        CFBundleDisplayName: Captions
        NSMicrophoneUsageDescription: "Used to caption what people near you are saying."
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: com.jonyen.watchcaptions.watchkitapp
        GENERATE_INFOPLIST_FILE: NO
        MARKETING_VERSION: "1.0"
        CURRENT_PROJECT_VERSION: "1"
```

- [ ] **Step 3: Create `watch/WatchCaptions/Info.plist`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>WKApplication</key>
  <true/>
  <key>CFBundleDisplayName</key>
  <string>Captions</string>
  <key>NSMicrophoneUsageDescription</key>
  <string>Used to caption what people near you are saying.</string>
</dict>
</plist>
```

- [ ] **Step 4: Create the committed secrets template `watch/WatchCaptions/Secrets.example.swift`**

```swift
import Foundation

/// Copy this file to `Secrets.swift` (gitignored) and fill in real values.
enum Secrets {
    static let relayURL = URL(string: "wss://YOUR-APP.fly.dev/stream")!
    static let authToken = "YOUR_AUTH_TOKEN"
}
```

- [ ] **Step 5: Create the real (gitignored) `watch/WatchCaptions/Secrets.swift`**

Use the live relay URL and the token from `/tmp/auth.token`. Read the token with
`cat /tmp/auth.token` and paste it as the `authToken` value. Do NOT commit this file.
```swift
import Foundation

enum Secrets {
    static let relayURL = URL(string: "wss://watch-captions-relay.fly.dev/stream")!
    static let authToken = "<paste contents of /tmp/auth.token here>"
}
```

- [ ] **Step 6: Create a minimal `watch/WatchCaptions/WatchCaptionsApp.swift`** (replaced in Task 8)

```swift
import SwiftUI
import CaptionCore

@main
struct WatchCaptionsApp: App {
    var body: some Scene {
        WindowGroup {
            Text("Captions")
        }
    }
}
```

- [ ] **Step 7: Generate the Xcode project**

Run: `cd watch && xcodegen generate`
Expected: `Created project at .../watch/WatchCaptions.xcodeproj`.

- [ ] **Step 8: Build for the watchOS simulator**

Run:
```bash
cd watch && xcodebuild build \
  -project WatchCaptions.xcodeproj \
  -scheme WatchCaptions \
  -destination 'platform=watchOS Simulator,name=Apple Watch Series 11 (46mm)'
```
Expected: `** BUILD SUCCEEDED **`. (If a watchOS target setting errors, fix it in `project.yml`, re-run `xcodegen generate`, and rebuild.)

- [ ] **Step 9: Commit**

```bash
git add watch/project.yml watch/WatchCaptions/Info.plist watch/WatchCaptions/WatchCaptionsApp.swift watch/WatchCaptions/Secrets.example.swift .gitignore
git commit -m "chore: scaffold watchOS app target with XcodeGen + CaptionCore"
```
(Confirm `git status` shows `Secrets.swift` and `*.xcodeproj` as ignored, not staged.)

---

### Task 6: `RelayClient` — WebSocket transport

`RelayClient` is device/manual (no unit test). Provide the code and confirm it compiles.

**Files:**
- Create: `watch/WatchCaptions/RelayClient.swift`

- [ ] **Step 1: Implement**

```swift
import Foundation
import CaptionCore

/// `Relay` over URLSessionWebSocketTask. Callbacks hop to the main actor.
final class RelayClient: Relay {
    var onMessage: (@MainActor (ServerMessage) -> Void)?
    var onClose: (@MainActor () -> Void)?

    private let url: URL
    private let session = URLSession(configuration: .default)
    private var task: URLSessionWebSocketTask?

    /// `url` must already include `?token=…`.
    init(url: URL) { self.url = url }

    func connect() {
        let task = session.webSocketTask(with: url)
        self.task = task
        task.resume()
        receive()
    }

    func send(_ audio: Data) {
        task?.send(.data(audio)) { _ in }
    }

    func close() {
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }

    private func receive() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure:
                Task { @MainActor in self.onClose?() }
            case .success(let message):
                if let data = Self.payload(of: message),
                   let parsed = try? ServerMessage.decode(data) {
                    Task { @MainActor in self.onMessage?(parsed) }
                }
                self.receive()   // keep listening
            }
        }
    }

    private static func payload(of message: URLSessionWebSocketTask.Message) -> Data? {
        switch message {
        case .string(let s): return Data(s.utf8)
        case .data(let d): return d
        @unknown default: return nil
        }
    }
}
```

- [ ] **Step 2: Build**

Run:
```bash
cd watch && xcodebuild build \
  -project WatchCaptions.xcodeproj -scheme WatchCaptions \
  -destination 'platform=watchOS Simulator,name=Apple Watch Series 11 (46mm)'
```
Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 3: Commit**

```bash
git add watch/WatchCaptions/RelayClient.swift
git commit -m "feat: add RelayClient websocket transport"
```

---

### Task 7: `AudioCapture` — mic → 16 kHz mono Int16 PCM

Device/manual (no unit test). Provide the code and confirm it compiles.

**Files:**
- Create: `watch/WatchCaptions/AudioCapture.swift`

- [ ] **Step 1: Implement**

```swift
import Foundation
import AVFoundation
import CaptionCore

/// Captures the mic and emits 16 kHz mono Int16 PCM chunks.
final class AudioCapture: AudioCapturing {
    private let engine = AVAudioEngine()
    private var converter: AVAudioConverter?
    private let targetFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!

    func start(onChunk: @escaping (Data) -> Void) throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement)
        try session.setActive(true)

        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard let converter = AVAudioConverter(from: inputFormat, to: targetFormat) else {
            throw AudioError.converterUnavailable
        }
        self.converter = converter

        input.installTap(onBus: 0, bufferSize: 1_600, format: inputFormat) { [weak self] buffer, _ in
            guard let self, let data = self.convert(buffer), !data.isEmpty else { return }
            onChunk(data)
        }
        engine.prepare()
        try engine.start()
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        converter = nil
        try? AVAudioSession.sharedInstance().setActive(false)
    }

    private func convert(_ buffer: AVAudioPCMBuffer) -> Data? {
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
        return Data(bytes: channel[0], count: Int(out.frameLength) * MemoryLayout<Int16>.size)
    }

    enum AudioError: Error { case converterUnavailable }
}
```

- [ ] **Step 2: Build**

Run:
```bash
cd watch && xcodebuild build \
  -project WatchCaptions.xcodeproj -scheme WatchCaptions \
  -destination 'platform=watchOS Simulator,name=Apple Watch Series 11 (46mm)'
```
Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 3: Commit**

```bash
git add watch/WatchCaptions/AudioCapture.swift
git commit -m "feat: add AudioCapture mic pipeline"
```

---

### Task 8: Permission, Views, and app wiring (`scenePhase`)

Device/manual. This replaces the placeholder app with the real UI and lifecycle.

**Files:**
- Create: `watch/WatchCaptions/MicPermission.swift`
- Create: `watch/WatchCaptions/Views/CaptionView.swift`
- Create: `watch/WatchCaptions/Views/ConnectingView.swift`
- Create: `watch/WatchCaptions/Views/ErrorView.swift`
- Create: `watch/WatchCaptions/AppModel.swift`
- Modify (replace): `watch/WatchCaptions/WatchCaptionsApp.swift`

- [ ] **Step 1: `MicPermission`**

`watch/WatchCaptions/MicPermission.swift`:
```swift
import Foundation
import AVFoundation
import CaptionCore

struct MicPermission: MicPermissionProviding {
    func ensureGranted() async -> Bool {
        await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { granted in
                continuation.resume(returning: granted)
            }
        }
    }
}
```

- [ ] **Step 2: `CaptionView`**

`watch/WatchCaptions/Views/CaptionView.swift`:
```swift
import SwiftUI
import CaptionCore

struct CaptionView: View {
    @ObservedObject var store: CaptionStore

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(store.lines.enumerated()), id: \.offset) { _, line in
                        Text(line).font(.system(size: 16))
                    }
                    if !store.partial.isEmpty {
                        Text(store.partial).font(.system(size: 16)).foregroundStyle(.secondary)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .onChange(of: store.lines.count) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
            .onChange(of: store.partial) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
            .overlay(alignment: .topTrailing) {
                Circle().fill(.green).frame(width: 7, height: 7)
            }
        }
    }
}
```

- [ ] **Step 3: `ConnectingView`**

`watch/WatchCaptions/Views/ConnectingView.swift`:
```swift
import SwiftUI

struct ConnectingView: View {
    var body: some View {
        VStack(spacing: 8) {
            ProgressView()
            Text("Connecting…").foregroundStyle(.secondary)
        }
    }
}
```

- [ ] **Step 4: `ErrorView`**

`watch/WatchCaptions/Views/ErrorView.swift`:
```swift
import SwiftUI

struct ErrorView: View {
    let message: String
    let onRetry: () -> Void

    var body: some View {
        VStack(spacing: 10) {
            Text(message)
                .font(.footnote)
                .multilineTextAlignment(.center)
                .foregroundStyle(.red)
            Button("Try Again", action: onRetry)
        }
        .padding()
    }
}
```

- [ ] **Step 5: `AppModel`** (wires concrete dependencies, owns store + controller)

`watch/WatchCaptions/AppModel.swift`:
```swift
import Foundation
import CaptionCore

@MainActor
final class AppModel: ObservableObject {
    let store = CaptionStore()
    private let controller: SessionController

    init() {
        let url = Self.tokenizedURL(Secrets.relayURL, token: Secrets.authToken)
        let controller = SessionController(
            store: store,
            relay: RelayClient(url: url),
            audio: AudioCapture(),
            permission: MicPermission()
        )
        self.controller = controller
    }

    func start() async { await controller.start() }
    func stop() { controller.stop() }

    private static func tokenizedURL(_ base: URL, token: String) -> URL {
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "token", value: token)]
        return components.url!
    }
}
```

- [ ] **Step 6: Replace `WatchCaptionsApp.swift`**

`watch/WatchCaptions/WatchCaptionsApp.swift` (full replacement):
```swift
import SwiftUI
import CaptionCore

@main
struct WatchCaptionsApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView(store: model.store) { Task { await model.start() } }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active: Task { await model.start() }
            case .inactive, .background: model.stop()
            @unknown default: break
            }
        }
    }
}

private struct RootView: View {
    @ObservedObject var store: CaptionStore
    let onRetry: () -> Void

    var body: some View {
        switch store.state {
        case .connecting: ConnectingView()
        case .listening: CaptionView(store: store)
        case .error(let message): ErrorView(message: message, onRetry: onRetry)
        }
    }
}
```

- [ ] **Step 7: Regenerate + build**

Run:
```bash
cd watch && xcodegen generate && xcodebuild build \
  -project WatchCaptions.xcodeproj -scheme WatchCaptions \
  -destination 'platform=watchOS Simulator,name=Apple Watch Series 11 (46mm)'
```
Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 8: Commit**

```bash
git add watch/WatchCaptions/MicPermission.swift watch/WatchCaptions/Views watch/WatchCaptions/AppModel.swift watch/WatchCaptions/WatchCaptionsApp.swift
git commit -m "feat: add views, permission, and scenePhase-driven session wiring"
```

---

### Task 9: README + final verification

**Files:**
- Create: `watch/README.md`

- [ ] **Step 1: Write `watch/README.md`**

````markdown
# WatchCaptions — watchOS live-caption app

Standalone watchOS app that streams the Watch mic to the caption relay and shows live captions.
Runs whenever the app is open (no buttons); stops when you lower your wrist / background it.

## Layout
- `CaptionCore/` — Swift package with the pure logic (`ServerMessage`, `CaptionStore`,
  `SessionController`, protocols). Unit-tested with `swift test`.
- `WatchCaptions/` — the watchOS app: `RelayClient` (WebSocket), `AudioCapture` (mic →
  16 kHz mono Int16 PCM), `MicPermission`, SwiftUI views, `@main` app.
- `project.yml` — XcodeGen project definition. The `.xcodeproj` is generated (gitignored).

## Setup
1. `cp WatchCaptions/Secrets.example.swift WatchCaptions/Secrets.swift`
2. Edit `Secrets.swift`: set `relayURL` to `wss://watch-captions-relay.fly.dev/stream` and
   `authToken` to the token from the Fly deploy (`/tmp/auth.token`). This file is gitignored.
3. `cd watch && xcodegen generate && open WatchCaptions.xcodeproj`

## Test (logic)
```bash
cd watch/CaptionCore && swift test
```

## Build (app)
```bash
cd watch && xcodebuild build -project WatchCaptions.xcodeproj -scheme WatchCaptions \
  -destination 'platform=watchOS Simulator,name=Apple Watch Series 11 (46mm)'
```

## Run on your Watch (manual)
1. Open `WatchCaptions.xcodeproj` in Xcode, select your paired Apple Watch, set your signing team.
2. Run. On first launch, allow the microphone prompt.
3. Speak (or have someone speak) — captions appear live (partial dimmed → final). The green dot
   means it's streaming. Lower your wrist / leave the app to stop.
4. Error check: temporarily set a wrong `authToken` → app shows "Connection lost" / Try Again.
````

- [ ] **Step 2: Final logic-test run**

Run: `cd watch/CaptionCore && swift test`
Expected: PASS — all tests across ServerMessage, CaptionStore, SessionController, smoke.

- [ ] **Step 3: Final app build**

Run:
```bash
cd watch && xcodegen generate && xcodebuild build \
  -project WatchCaptions.xcodeproj -scheme WatchCaptions \
  -destination 'platform=watchOS Simulator,name=Apple Watch Series 11 (46mm)'
```
Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 4: Commit**

```bash
git add watch/README.md
git commit -m "docs: add watchOS app README and run instructions"
```

---

## Manual on-device acceptance (after the plan, by the human)

The unit tests + simulator build are automated. The real end-to-end test is on-device against the
**live relay** (already deployed): build to a paired Apple Watch, grant mic access, speak, and
confirm live captions, partial→final behavior, auto-scroll, the green live dot, and that
lowering the wrist stops streaming. This is the acceptance gate for Phase 1.
