# On-device Moonshine captions Implementation Plan (Part B of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "On device" session to the watch app that captions through Moonshine Tiny on the watch's Neural Engine via `MoonshineKit`, alongside the existing Deepgram relay path.

**Architecture:** `MoonshineEngine` conforms to caption-core's `CaptionEngine` and wraps `MoonshineKit.LiveTranscriber`; a third `SessionController` in `AppModel` drives it with the same `AudioCapture`, `CaptionStore` and `CaptionView` the relay session uses. Compiled models are fetched into `watch/Models/MoonshineTiny/` (gitignored) and bundled as a folder resource.

**Tech Stack:** SwiftUI watchOS 11, XcodeGen, SPM dependency on `jonyen/moonshine-coreml` (0.1.0), caption-core `CaptionEngine`.

**Spec:** `~/Projects/moonshine-coreml/docs/superpowers/specs/2026-08-22-moonshine-watch-captions-design.md` — Part 2. Requires Part A's plan (`~/Projects/moonshine-coreml/docs/superpowers/plans/2026-08-22-moonshine-coreml.md`) to be complete through A8 (the `v0.1.0` release must exist).

## Global Constraints

- Repo: `~/Projects/apple-watch-captions`, `watch/` target only. No change to `ios/`, `backend/`, `CaptionRelay/`.
- watchOS deployment target becomes `11.0` (stateful Core ML). Bundle id, team, signing unchanged.
- `watch/Models/` is gitignored; `watch/Scripts/fetch-moonshine.sh <version>` populates it; README says so. `xcodegen generate` needs it present.
- Engine events: partial → `.caption(text:isFinal:false, channel:nil)`, final → `.caption(text:isFinal:true, channel:nil)`; load failure → `.error(message: "On-device model failed to load")`; three consecutive inference failures → `.error(message: "On-device captions failed")`.
- On-device sessions are live-only (nothing saved to the relay) in v1. Indicator label: `"On device, not saved"`. Home row: `Label("On device", systemImage: "cpu")`.
- Build check for every task: `cd watch && xcodegen generate && xcodebuild -project WatchCaptions.xcodeproj -scheme WatchCaptions -destination 'generic/platform=watchOS Simulator' CODE_SIGNING_ALLOWED=NO build 2>&1 | tail -3` → `** BUILD SUCCEEDED **`. Use `-scheme`, never `-target` (SPM products only resolve through a scheme).
- Commit after every task; normal-prose messages with the trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Commit only the files each task names — the working tree may hold unrelated changes; check `git status` first and leave them alone.

---

## File map

| Path | Change |
|---|---|
| `watch/project.yml` | package `MoonshineKit`, deployment target 11.0, `Models/MoonshineTiny` folder resource |
| `watch/Scripts/fetch-moonshine.sh` | new: downloads the release zip into `watch/Models/MoonshineTiny/` |
| `.gitignore` | `watch/Models/` |
| `watch/README.md` | fetch step, On device row |
| `watch/WatchCaptions/MoonshineEngine.swift` | new: `CaptionEngine` over `LiveTranscriber` |
| `watch/WatchCaptions/Views/CaptionView.swift` | `CaptionIndicator.onDevice` |
| `watch/WatchCaptions/Views/HomeView.swift` | "On device" row |
| `watch/WatchCaptions/AppModel.swift` | `onDeviceController`, `onDevice`, `startOnDevice()`, stop/retry routing |
| `watch/WatchCaptions/WatchCaptionsApp.swift` | pass the new row action; indicator selection |

---

### Task B1: Project wiring — package, models, deployment target

**Files:**
- Modify: `watch/project.yml`
- Create: `watch/Scripts/fetch-moonshine.sh`
- Modify: `.gitignore`, `watch/README.md`

- [ ] **Step 1: Fetch script**

`watch/Scripts/fetch-moonshine.sh`:
```bash
#!/bin/bash
# Downloads the compiled Moonshine Tiny Core ML models the "On device" session
# uses, from a moonshine-coreml release, into watch/Models/MoonshineTiny/.
# Run before `xcodegen generate`. Usage: watch/Scripts/fetch-moonshine.sh [0.1.0]
set -euo pipefail
VERSION="${1:-0.1.0}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/Models/MoonshineTiny"
URL="https://github.com/jonyen/moonshine-coreml/releases/download/v$VERSION/moonshine-tiny-coreml-v$VERSION.zip"
TMP="$(mktemp -d)"
curl -fL "$URL" -o "$TMP/models.zip"
rm -rf "$DEST" && mkdir -p "$DEST"
unzip -oq "$TMP/models.zip" -d "$DEST"
rm -rf "$TMP"
echo "Moonshine Tiny v$VERSION in $DEST:"; ls "$DEST"
```
Run: `chmod +x watch/Scripts/fetch-moonshine.sh && watch/Scripts/fetch-moonshine.sh 0.1.0`
Expected: `Encoder.mlmodelc  Decoder.mlmodelc  vocab.json` listed.

- [ ] **Step 2: gitignore**

Append to the root `.gitignore`, under `# watchOS app`:
```
watch/Models/
```

- [ ] **Step 3: project.yml**

In `watch/project.yml`:
- `options.deploymentTarget.watchOS: "11.0"` (was `"10.0"`).
- Under `packages:` add
  ```yaml
  MoonshineKit:
    url: https://github.com/jonyen/moonshine-coreml
    from: 0.1.0
  ```
- Under `targets.WatchCaptions.sources` add a second entry after the existing `WatchCaptions` one:
  ```yaml
      - path: Models/MoonshineTiny
        type: folder
        buildPhase: resources
  ```
  (`type: folder` makes a blue folder reference, copied into the bundle as `MoonshineTiny/` with the `.mlmodelc` directories inside — already compiled, so Xcode does not try to compile them.)
- Under `targets.WatchCaptions.dependencies` add `- package: MoonshineKit`.

- [ ] **Step 4: Build**

Run the build check from Global Constraints. Expected: `** BUILD SUCCEEDED **`. Then confirm the models landed in the product:
`ls "$(xcodebuild -project watch/WatchCaptions.xcodeproj -scheme WatchCaptions -destination 'generic/platform=watchOS Simulator' -showBuildSettings 2>/dev/null | awk '/ BUILT_PRODUCTS_DIR/ {print $3}')/WatchCaptions.app/MoonshineTiny"` → the three entries. (If the first attempt says the package cannot be resolved, `xcodebuild -resolvePackageDependencies -project watch/WatchCaptions.xcodeproj -scheme WatchCaptions` once.)

- [ ] **Step 5: README**

In `watch/README.md`, after the `Secrets.swift` steps and before `xcodegen generate`, add a step: `Scripts/fetch-moonshine.sh` — "downloads the on-device Moonshine Tiny models (~55 MB) into `Models/MoonshineTiny/`; the project references that folder, so generate after fetching." Add one sentence to the features list: "On device — captions computed on the watch with Moonshine Tiny (watchOS 11+, best on S9 and later); nothing leaves the watch and nothing is saved."

- [ ] **Step 6: Commit**

```bash
git add watch/project.yml watch/Scripts/fetch-moonshine.sh .gitignore watch/README.md
git commit -m "build(watch): depend on MoonshineKit and bundle the Moonshine Tiny models"
```

---

### Task B2: MoonshineEngine

**Files:**
- Create: `watch/WatchCaptions/MoonshineEngine.swift`

**Interfaces:**
- Consumes: `CaptionEngine` (caption-core: `onEvent`, `onClose`, `start()`, `send(Data)`, `close()`), `MoonshineKit.MoonshineModel`, `Transcriber`, `LiveTranscriber`.
- Produces: `final class MoonshineEngine: CaptionEngine { init(modelDirectory: URL = MoonshineEngine.bundledModels) }`, `static let bundledModels: URL`.

The engine's own logic is thin (event mapping and a failure counter); the pipeline underneath is unit-tested in MoonshineKit. The watch target has no test target, so this task is verified by the build and by B4 on the device.

- [ ] **Step 1: Write it**

```swift
import Foundation
import os
import CaptionCore
import MoonshineKit

/// On-device captions: Moonshine Tiny on Core ML, fed the same 16 kHz mono
/// Int16 PCM `AudioCapture` sends the relay. Models load once, on the first
/// `start()`, and stay loaded for the life of the app — loading is the slow
/// part, not inference.
final class MoonshineEngine: CaptionEngine {
    var onEvent: (@MainActor (CaptionEvent) -> Void)?
    var onClose: (@MainActor () -> Void)?

    /// Where `project.yml` puts the folder `Scripts/fetch-moonshine.sh` downloads.
    static let bundledModels = Bundle.main.resourceURL!.appendingPathComponent("MoonshineTiny")

    /// Inference errors in a row before the session is given up on; one bad
    /// segment is dropped silently and the next one gets its chance.
    static let failureLimit = 3

    private let modelDirectory: URL
    private let lock = NSLock()
    private var live: LiveTranscriber?
    private var loading = false
    private var consecutiveFailures = 0
    private let log = Logger(subsystem: "com.jonyen.watchcaptions", category: "MoonshineEngine")

    init(modelDirectory: URL = MoonshineEngine.bundledModels) {
        self.modelDirectory = modelDirectory
    }

    func start() {
        lock.lock()
        consecutiveFailures = 0
        if let live {
            live.reset()
            lock.unlock()
            emit(.ready)
            return
        }
        guard !loading else { lock.unlock(); return }
        loading = true
        lock.unlock()

        let directory = modelDirectory
        Task.detached(priority: .userInitiated) { [weak self] in
            do {
                let model = try MoonshineModel(directory: directory)
                let live = LiveTranscriber(transcriber: Transcriber(model: model))
                guard let self else { return }
                live.onPartial = { [weak self] text in self?.report(text, isFinal: false) }
                live.onFinal = { [weak self] text in self?.report(text, isFinal: true) }
                live.onError = { [weak self] error in self?.failed(error) }
                self.lock.lock()
                self.live = live
                self.loading = false
                self.lock.unlock()
                self.emit(.ready)
            } catch {
                self?.log.error("model load failed: \(String(describing: error), privacy: .public)")
                self?.lock.lock(); self?.loading = false; self?.lock.unlock()
                self?.emit(.error(message: "On-device model failed to load"))
            }
        }
    }

    /// Called on the audio thread.
    func send(_ audio: Data) {
        lock.lock(); let live = self.live; lock.unlock()
        guard let live, audio.count >= 2 else { return }
        var samples = [Int16](repeating: 0, count: audio.count / 2)
        _ = samples.withUnsafeMutableBytes { audio.copyBytes(to: $0) }
        live.feed(samples)
    }

    /// Drops the open segment and anything queued; keeps the models.
    /// `SessionController.stop()` has already cleared `running`, so a final
    /// flushed here would be discarded anyway.
    func close() {
        lock.lock(); let live = self.live; lock.unlock()
        live?.reset()
    }

    // MARK: - Results

    private func report(_ text: String, isFinal: Bool) {
        lock.lock(); consecutiveFailures = 0; lock.unlock()
        emit(.caption(text: text, isFinal: isFinal, channel: nil))
    }

    private func failed(_ error: Error) {
        log.error("inference failed: \(String(describing: error), privacy: .public)")
        lock.lock()
        consecutiveFailures += 1
        let giveUp = consecutiveFailures >= Self.failureLimit
        lock.unlock()
        if giveUp { emit(.error(message: "On-device captions failed")) }
    }

    /// Main-queue FIFO, so a partial can never overtake the final that supersedes it.
    private func emit(_ event: CaptionEvent) {
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated { self?.onEvent?(event) }
        }
    }
}
```

- [ ] **Step 2: Build**

Run the build check. Expected: `** BUILD SUCCEEDED **`. If the compiler rejects `MainActor.assumeIsolated` inside the closure, replace the body of `emit` with `Task { @MainActor [weak self] in self?.onEvent?(event) }` and add a one-line comment that ordering is then best-effort.

- [ ] **Step 3: Commit**

```bash
git add watch/WatchCaptions/MoonshineEngine.swift
git commit -m "feat(watch): MoonshineEngine captions on-device through MoonshineKit"
```

---

### Task B3: The "On device" session

**Files:**
- Modify: `watch/WatchCaptions/Views/CaptionView.swift` (the `CaptionIndicator` enum at the top)
- Modify: `watch/WatchCaptions/Views/HomeView.swift`
- Modify: `watch/WatchCaptions/AppModel.swift`
- Modify: `watch/WatchCaptions/WatchCaptionsApp.swift`

**Interfaces:**
- Consumes: `MoonshineEngine` (B2), `SessionController`, `AudioCapture`, `MicPermission`.
- Produces: `AppModel.onDevice: Bool` (published), `AppModel.startOnDevice() async`, `HomeView.onOnDevice: () -> Void`, `CaptionIndicator.onDevice`.

- [ ] **Step 1: Indicator**

In `CaptionView.swift`, `enum CaptionIndicator`: add a case and its label.
```swift
    /// A mic session captioned on the watch itself; nothing is saved.
    case onDevice
```
and in `var label`: `case .onDevice: return "On device, not saved"`. Search the file for any other `switch` over the indicator (for example a colour or symbol) and give `.onDevice` the same treatment as `.liveOnly`.

- [ ] **Step 2: Home row**

In `HomeView.swift`, add a property after `onLive`:
```swift
    /// Caption on the watch itself — no relay, nothing saved.
    let onOnDevice: () -> Void
```
and a row directly under the "Off the record" button:
```swift
            Button(action: onOnDevice) {
                Label("On device", systemImage: "cpu")
            }
            .accessibilityHint("Captions computed on the watch. Nothing is saved.")
```
Fix every `HomeView(` call site the compiler flags (the RootView in `WatchCaptionsApp.swift`, plus any `#Preview`/`PreviewProvider` in `HomeView.swift`), passing `onOnDevice: {}` in previews.

- [ ] **Step 3: AppModel**

In `AppModel.swift`:
- Next to `private let phoneController: SessionController` add
  ```swift
      /// The on-device session. Its own controller and engine — Moonshine on
      /// Core ML instead of the relay — but the same store and the same mic.
      private let onDeviceController: SessionController
  ```
- Near `@Published private(set) var readingPhone = false` add
  ```swift
      /// True while the running mic session is the on-device one, so Stop,
      /// retry and the indicator address the right controller. Live-only by
      /// construction: nothing reaches the relay.
      @Published private(set) var onDevice = false
  ```
- In `init`, right after `controller = SessionController(...)` is assigned:
  ```swift
          onDeviceController = SessionController(
              store: store,
              relay: MoonshineEngine(),
              audio: AudioCapture(),
              permission: micPermission)
  ```
- After `func startLive()` add
  ```swift
      /// Caption on the watch itself. Live-only: there is no transcript to
      /// resume or browse afterwards.
      func startOnDevice() async {
          stoppedExplicitly = false
          currentTranscript = nil
          live = true
          onDevice = true
          path = [.captions]
          capturing = true
          await onDeviceController.start()
      }
  ```
- `retry()`: route the on-device case first:
  ```swift
      func retry() async {
          if onDevice {
              await startOnDevice()
          } else if live {
              await startLive()
          } else {
              await startNew()
          }
      }
  ```
- `endCapture()`:
  ```swift
      private func endCapture() {
          if onDevice {
              onDeviceController.stop()
          } else {
              controller.stop()
              prefiller.cancel()
          }
          rememberCurrentSession()
          capturing = false
          live = false
          onDevice = false
      }
  ```
- `pause()`: replace `controller.stop()` with `(onDevice ? onDeviceController : controller).stop()`.

`rememberCurrentSession()` already returns early for a live session (`currentTranscript == nil`), so an on-device session is never offered under "Resume previous"; confirm by reading it, and if it keys off something else, add `guard !onDevice else { return }` at its top.

- [ ] **Step 4: RootView**

In `WatchCaptionsApp.swift`:
- In the `HomeView(` call add `onOnDevice: { Task { await model.startOnDevice() } },` after `onLive:`.
- In `private var captions`, the `.listening` case: `indicator: model.onDevice ? .onDevice : (model.live ? .liveOnly : .recording),`.

- [ ] **Step 5: Build**

Run the build check. Expected: `** BUILD SUCCEEDED **`. Then run it in the simulator once to see the row and the screen (the simulator runs Core ML on CPU — correctness only, it will be slow): `xcrun simctl list devices available | grep -i "watch"` to pick a watchOS 11+ simulator, then the XcodeBuildMCP `build_run_sim` flow or `xcodebuild ... -destination 'platform=watchOS Simulator,name=<name>'` + `xcrun simctl launch`. Tap "On device", grant the mic, speak into the Mac mic: gray partial then white final lines appear. If the model fails to load, the screen shows "On-device model failed to load" with Retry — check the bundle contains `MoonshineTiny/` (B1 step 4).

- [ ] **Step 6: Commit**

```bash
git add watch/WatchCaptions/Views/CaptionView.swift watch/WatchCaptions/Views/HomeView.swift watch/WatchCaptions/AppModel.swift watch/WatchCaptions/WatchCaptionsApp.swift
git commit -m "feat(watch): On device session captions with Moonshine Tiny on the watch"
```

---

### Task B4: On-device verification and docs

**Files:**
- Modify: `watch/README.md`, root `README.md` (one line in "Related repos" and the layout table)

- [ ] **Step 1: Run on the watch**

Open `watch/WatchCaptions.xcodeproj`, select the paired Apple Watch (S9 or later, watchOS 11+), Run. On the watch:
1. Tap **On device**. First launch: a second or two of "connecting" while the models load, then the caption screen with the "On device, not saved" indicator.
2. Speak a few sentences, pause between them. Expect a gray partial within ~1 s of starting to talk, and a white final shortly after each pause.
3. Tap Stop. Back on the menu, tap **New session** (Deepgram) and say the same sentences; compare quality and lag.
4. Background the app by lowering the wrist mid-sentence, raise it: captions continued.
5. In Xcode's Debug navigator or Instruments (Core ML template), note encode and per-token times; if they are far from the targets (encode 5 s ≤ 300 ms, ≤ 15 ms/token), that is the spec's "measure first" step — record the numbers, do not tune in this task.

- [ ] **Step 2: Record results**

Add to `watch/README.md` an "On device" subsection: what it is, watchOS 11 / S9+ requirement, the measured numbers from step 1.5 with the watch model, and the two known limits (live-only; the first start pays the model load). Add `jonyen/moonshine-coreml` to the root README's "Related repos" and mention the `On device` row in the watch layout line.

- [ ] **Step 3: Commit**

```bash
git add watch/README.md README.md
git commit -m "docs(watch): on-device captions — setup, requirements and measured timings"
```

---

## Self-review notes

- Spec Part 2 coverage: project changes (B1), MoonshineEngine with load/ready/error/failure-limit/close semantics (B2), entry row + third controller + indicator + retry/stop routing (B3), performance measurement and device verification (B4). Saving on-device transcripts is out of scope per spec.
- Names: `onDevice`, `startOnDevice()`, `onDeviceController`, `onOnDevice`, `CaptionIndicator.onDevice` used consistently; engine strings match Global Constraints.
