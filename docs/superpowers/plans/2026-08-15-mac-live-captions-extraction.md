# Mac Live Captions Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconcile the forked mains, reshape CaptionCore so nothing in it knows a relay exists, split `caption-core` and `mac-live-captions` into their own repos with history, and give the Mac app a global hotkey.

**Architecture:** One monorepo becomes three repos. The reshape happens *before* the split, on a branch where all three consumers (watch, iOS, mac) still build together. A new repo-local package `CaptionRelay` receives the relay-shaped types; the mac app is slimmed to on-device-only *inside* the monorepo so the split extracts an already-clean app. `git filter-repo` preserves history for both extractions.

**Tech Stack:** Swift 6.3 / Xcode 26.6, SPM, XcodeGen 2.44.1 (all `.xcodeproj` are generated — never edit them), git-filter-repo 2.47.0, `gh` CLI (authed as `jonyen`), Carbon HIToolbox (global hotkey), ServiceManagement (login item).

**Spec:** `docs/superpowers/specs/2026-08-15-mac-live-captions-extraction-design.md`

## Global Constraints

- Monorepo: `/Users/jonyen/Projects/apple-watch-captions`. Local `main` = `0e7b052` (preserved remotely as `origin/backup/local-main-2026-08-15`); `origin/main` = `398992b`; merge-base `38b9ca1`. Push to `origin` only; leave the `datavault` remote untouched.
- **backend/ belongs to the multi-tenant port plan** (`docs/superpowers/plans/2026-08-15-multi-tenant-port.md`, untracked — do not commit it). The ONLY backend change in this plan is Task 1's wholesale reset to origin/main.
- Untracked files that must survive every step: `watch/WatchCaptions/Secrets.swift`, `ios/Shared/Secrets.swift`, the port plan above.
- All `.xcodeproj` are gitignored and generated: after ANY `project.yml` change, run `xcodegen generate` in that directory before building.
- Build/test commands (run from the repo root unless noted):
  - CaptionCore: `cd watch/CaptionCore && swift test`
  - CaptionRelay (exists from Task 2): `cd CaptionRelay && swift test`
  - watch: `cd watch && xcodegen generate && xcodebuild build -project WatchCaptions.xcodeproj -scheme WatchCaptions -destination 'generic/platform=watchOS Simulator' CODE_SIGNING_ALLOWED=NO`
  - iOS: `cd ios && xcodegen generate && xcodebuild build -project PhoneCaptions.xcodeproj -scheme PhoneCaptions -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO`
  - mac: `cd mac && xcodegen generate && xcodebuild test -project Captions.xcodeproj -scheme Captions -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO`
  - backend (Task 1 gate only): `cd backend && npm ci && npm run build && npm test`
- "**Full gate**" below means: CaptionCore tests + CaptionRelay tests (once it exists) + watch build + iOS build + mac build&test, all green.
- Commit messages: conventional style matching the repo (`feat(watch): …`, `refactor(core): …`, `docs: …`), sentence-case subject, no trailing period.
- New repos: `github.com/jonyen/caption-core` and `github.com/jonyen/mac-live-captions`, both **public**, created with `gh repo create`. Local clones live at `/Users/jonyen/Projects/caption-core` and `/Users/jonyen/Projects/mac-live-captions`.
- Never deploy anything (no `fly deploy`).

---

### Task 1: Reconcile the forked mains

The 48-commit local lineage and the 5-commit origin lineage merge into one `main`. Backend resolves **wholesale** to origin/main — including non-conflicted files only the local side changed, because local-only backend modules (`callUplink.ts`, `chooseSummarizer.ts`, the expansive `summaryPrompt.ts`, …) reference each other and would break origin's `npm run build` if left behind. The 9 watch conflict hunks are hand-resolved with the exact code below.

**Files:**
- Modify (merge): entire tree; hand-resolutions in `watch/WatchCaptions/AppModel.swift`, `watch/WatchCaptions/Views/HomeView.swift`, `watch/WatchCaptions/Views/CaptionView.swift`, `watch/WatchCaptions/WatchCaptionsApp.swift`
- Reset to origin/main: `backend/**`, `.github/workflows/ci.yml`
- Modify (untracked, do not commit): `docs/superpowers/plans/2026-08-15-multi-tenant-port.md`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: a single `main` containing both lineages' watch/iOS/mac/CaptionCore work and origin's backend. Every later task starts from this `main`.

- [ ] **Step 1: Start the merge**

```bash
cd /Users/jonyen/Projects/apple-watch-captions
git checkout main
git merge origin/main --no-ff -m "WIP"   # stops with 16 conflicts; message replaced at commit time
```

- [ ] **Step 2: Backend and CI wholesale to origin/main**

```bash
git rm -rqf backend          # -f: several paths are in the unmerged state
git checkout origin/main -- backend
git checkout origin/main -- .github/workflows/ci.yml
```

The `git rm` first matters: `git checkout origin/main -- backend` alone would overlay origin's files but leave local-only backend modules in place, and `tsc` compiles everything under `backend/src/`.

- [ ] **Step 3: Resolve `watch/WatchCaptions/Views/HomeView.swift` (2 hunks)**

Hunk 1 — property block. Both sides added a menu action; keep both (order defines the memberwise-init argument order used in Step 6's call site):

```swift
    let onTakeCall: () -> Void
    /// Read audio playing on the iPhone. Offered only while the phone is
    /// actually broadcasting — there is nothing to read otherwise, and the row
    /// would only lead to a screen explaining its own uselessness.
    let onPhone: () -> Void
    var phoneBroadcasting: Bool = false
```

Hunk 2 — menu rows. Local's always-present "Tune in" row, then origin's conditional "iPhone audio" row:

```swift
            Button(action: onTakeCall) {
                Label("Tune in", systemImage: "antenna.radiowaves.left.and.right")
            }
            if phoneBroadcasting {
                Button(action: onPhone) {
                    Label("iPhone audio", systemImage: "iphone")
                }
            }
```

(Adjust the exact brace placement to the surrounding merged body — the two rows must both end up inside the menu's row list. Compare with both parents' versions of the file if unsure: `git show main:watch/WatchCaptions/Views/HomeView.swift`, `git show origin/main:…`.)

- [ ] **Step 4: Resolve `watch/WatchCaptions/Views/CaptionView.swift` (2 hunks)**

Hunk 1 — indicator labels. Local renamed the call labels; origin added the `.phone` case. The `.phone` line is **mandatory**: the enum case merged in outside the markers, so dropping it is a non-exhaustive switch:

```swift
        case .call: return "Tuned in"
        case .phone: return "Reading iPhone audio"
        case .callEnded(.ended): return "Audio ended"
```

Hunk 2 — the `textSize` property + `onStop` doc. Origin's `var textSize` declaration exists ONLY in this hunk while its uses merged in unconflicted (`.font(.system(size: textSize))`), so it must survive; local's rewritten `onStop` doc wins over base's:

```swift
    /// Set from the phone. A default here so previews and any future caller
    /// need not thread it through to say "the usual size".
    var textSize: Double = 16
    /// Absent when there is nothing this screen can stop. A mic session and a
    /// call the watch holds both have one — for a held call, Stop closes the
    /// relay's stream, which is what ends the call. The relay's fallback does
    /// not: the phone holds that call, so a Stop button there would claim a
    /// power the watch has no way to exercise.
```

- [ ] **Step 5: Resolve `watch/WatchCaptions/AppModel.swift` (1 hunk)**

Adjacent stored-property blocks; keep both sides in full:

```swift
    /// Push-to-talk state for the call on screen.
    let callVoice: CallVoice
    private let callAudio: CallAudio
    private let audioPlayer = CallAudioPlayer()
    private var callAudioTask: Task<Void, Never>?
    /// Identifies the push-to-talk turn currently open. `endTalking()` un-mutes
    /// after an `await`, and a release-then-press during that in-flight send
    /// would otherwise have turn 1's continuation un-mute turn 2's open
    /// microphone — the speaker resuming into a live mic, sending the caller
    /// back to themselves about four seconds late. Compared after the await.
    private var turnGeneration = 0
    /// True from the moment a hangup starts until the next call screen opens.
    /// See `endCall()`.
    private var endingCall = false
    /// True once this call's audio engine has been asked to start. See
    /// `callArrived(twoWay:)`.
    private var callAudioStarted = false
    /// Reads audio playing on the iPhone. Its own controller and transport,
    /// because it joins a session the phone owns rather than starting one — but
    /// it shares `store`, since only one thing is ever on screen.
    private let phoneController: SessionController
    private let settingsClient: RelaySettingsClient
    /// What the phone last said. Defaults until the relay answers, so the app
    /// works unchanged when it cannot be reached.
    @Published private(set) var settings: Settings = .defaults
```

plus whatever origin-side properties follow in the conflict's "theirs" block (`readingPhone` / `phoneBroadcasting` state — take them verbatim from the marker block). The rest of the 28KB file auto-merged; both `Route.call` and `Route.phone`, both method families, coexist.

- [ ] **Step 6: Resolve `watch/WatchCaptions/WatchCaptionsApp.swift` (4 hunks)**

Hunk 1 — HomeView call site (argument order from Step 3):

```swift
                    onTakeCall: { model.takeCall() },
                    onPhone: { Task { await model.startPhoneAudio() } },
                    phoneBroadcasting: model.phoneBroadcasting)
```

Hunk 2 — route `.onDisappear`s. Merged `leaveCall()` is `async` (local's version won), so origin's bare `model.leaveCall()` would not compile; keep local's Task-wrapped call and add origin's `.phone` route:

```swift
                            // Closing the stream is what ends the call, so
                            // backing out hangs up exactly like tapping End.
                            .onDisappear { Task { await model.leaveCall() } }
                    case .phone:
                        phone
                            // Leaving stops reading. The phone keeps broadcasting.
                            .onDisappear { model.leavePhoneAudio() }
```

Hunk 3 — mic-session CaptionView call site:

```swift
                textSize: model.settings.captionTextSize,
                onStop: { model.stop() },
                onTalkChanged: nil)
```

Hunk 4 — call-screen CaptionView call site (local's two-way gating + origin's textSize):

```swift
                textSize: model.settings.captionTextSize,
                // Stop only where it can do something: on the fallback the
                // phone holds the call, and nothing here can hang it up.
                onStop: model.callTwoWay ? { Task { await model.endCall() } } : nil,
                // Same for the talk gesture — that stream is one-way, so a
                // turn recorded into it could only end in a refusal.
                onTalkChanged: model.callTwoWay ? { talking in
                    Task {
                        if talking { model.beginTalking() }
                        else { await model.endTalking() }
                    }
                } : nil,
                isTalking: model.callVoice.isTalking)
```

CaptionView's resolved parameter order is `(store, indicator, textSize, onStop, onTalkChanged, isTalking)` — verify the call sites against the resolved CaptionView from Step 4.

- [ ] **Step 7: Verify no conflict markers remain, commit the merge**

```bash
git diff --check
git grep -nE '^(<{7}|={7}|>{7})' -- '*.swift' '*.ts' '*.yml' '*.md' || true   # expect no output
git add -A
git commit -m "Merge origin/main: multi-tenant relay joins the local lineage

backend/ resolves wholesale to origin/main — the local backend features
(expansive summaries, resummarize, two-way call audio) are carried forward
separately by the multi-tenant port plan from backup/local-main-2026-08-15.
Watch UI conflicts hand-resolved keeping both sides' features."
```

- [ ] **Step 8: Run the full gate + backend gate**

Run all five build/test commands from Global Constraints, plus the backend gate. Expected: everything passes. If the watch build fails, the failure is in one of the four hand-resolved files — fix against both parents' intent, amend the merge commit.

- [ ] **Step 9: Repoint the port plan's source-of-truth refs (untracked file — edit, don't commit)**

In `docs/superpowers/plans/2026-08-15-multi-tenant-port.md`, replace every `git show main:backend/` with `git show backup/local-main-2026-08-15:backend/`, and the prose "The source of truth for ported code is `git show main:backend/src/<file>`" accordingly. After this merge, `main` no longer means the local lineage.

```bash
sed -i '' 's|git show main:backend/|git show backup/local-main-2026-08-15:backend/|g; s|`git show main:backend/src/<file>`|`git show backup/local-main-2026-08-15:backend/src/<file>`|g' docs/superpowers/plans/2026-08-15-multi-tenant-port.md
grep -n "main:backend" docs/superpowers/plans/2026-08-15-multi-tenant-port.md   # expect: no matches
```

- [ ] **Step 10: Bring the docs branch onto main and push**

```bash
git merge feat/multi-tenant-migration -m "Merge extraction and migration design docs"
git push origin main
```

(`feat/multi-tenant-migration` is origin/main + doc commits only; no conflicts. `origin/main` is an ancestor of the merge, so this is a normal push.)

---

### Task 2: Create CaptionRelay and move the first ten files

Creates the repo-local package and moves everything that neither core nor the renames depend on. `SessionMode` and `History.swift` stay in core until Tasks 5–6 (core still references them). Also does the two pieces of core surgery this split needs: `TranscriptSegment` moves *into* core, `parseISODate` becomes public.

Work on a branch: `git checkout -b feat/extraction-reshape` (Tasks 2–6 all commit here).

**Files:**
- Create: `CaptionRelay/Package.swift`, `CaptionRelay/Sources/CaptionRelay/` (moved files), `CaptionRelay/Tests/CaptionRelayTests/` (moved tests), `watch/CaptionCore/Sources/CaptionCore/TranscriptSegment.swift`
- Modify: `watch/CaptionCore/Sources/CaptionCore/History.swift` (remove TranscriptSegment), `watch/CaptionCore/Sources/CaptionCore/Paragraphs.swift` (`parseISODate` public), `watch/project.yml`, `ios/project.yml`, `ios/PhoneCaptionsUpload/SampleHandler.swift`, `ios/Shared/PresenceWatcher.swift`, `ios/Shared/RelayUploader.swift`, watch app files that use moved types (imports)

**Interfaces:**
- Consumes: merged `main` from Task 1.
- Produces: module `CaptionRelay` (depends on `CaptionCore` by path) containing `CallAudio`, `CallVoice`, `CallCaptions` (with `CallUpdate`, `CallClient`, `decodeCallUpdate`), `MuLaw`, `PCMConverter`, `Settings`, `LaunchAction`, `BuildInfo`, `PhoneAudio`, `ExportWatcher`. Core additionally exports `TranscriptSegment` and public `parseISODate(_:) -> Date?`. Later tasks import `CaptionRelay` from watch/iOS code freely.

- [ ] **Step 1: Package scaffold**

`CaptionRelay/Package.swift`:

```swift
// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CaptionRelay",
    platforms: [.watchOS(.v10), .iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "CaptionRelay", targets: ["CaptionRelay"]),
    ],
    dependencies: [
        .package(path: "../watch/CaptionCore"),
    ],
    targets: [
        .target(name: "CaptionRelay", dependencies: ["CaptionCore"]),
        .testTarget(name: "CaptionRelayTests", dependencies: ["CaptionRelay"]),
    ]
)
```

- [ ] **Step 2: Move TranscriptSegment into core**

Create `watch/CaptionCore/Sources/CaptionCore/TranscriptSegment.swift` containing the `TranscriptSegment` struct **verbatim as it appears in `History.swift`** (the `public struct TranscriptSegment: Equatable, Identifiable, Sendable { … }` block including its custom `==`), plus `import Foundation`. Delete that block from `History.swift`. Same module, so nothing else changes yet.

- [ ] **Step 3: Make `parseISODate` public**

In `Paragraphs.swift`, change `func parseISODate(` to `public func parseISODate(` (the leaving `TranscriptRow.format` calls it and will soon be in another module).

- [ ] **Step 4: Move the ten source files and their tests**

```bash
mkdir -p CaptionRelay/Sources/CaptionRelay CaptionRelay/Tests/CaptionRelayTests
for f in CallAudio CallVoice CallCaptions MuLaw PCMConverter Settings LaunchAction BuildInfo PhoneAudio ExportWatcher; do
  git mv watch/CaptionCore/Sources/CaptionCore/$f.swift CaptionRelay/Sources/CaptionRelay/
done
for t in CallCaptionsTests PCMConverterTests SettingsTests LaunchActionTests BuildInfoTests ExportWatcherTests; do
  git mv watch/CaptionCore/Tests/CaptionCoreTests/$t.swift CaptionRelay/Tests/CaptionRelayTests/
done
```

In the moved sources: `CallCaptions.swift` references core types (`ServerMessage`, `CaptionStore`) — add `import CaptionCore` at its top. Check the other nine compile without it (`swift build` in CaptionRelay); add `import CaptionCore` only where the compiler asks.

In the moved tests: change `@testable import CaptionCore` → `@testable import CaptionRelay`, and add a plain `import CaptionCore` to any test file the compiler flags (CallCaptionsTests uses `CaptionStore`/`ServerMessage`).

- [ ] **Step 5: Run both package suites**

```bash
(cd CaptionRelay && swift test) && (cd watch/CaptionCore && swift test)
```

Expected: PASS (moves only, no behavior change). CaptionCore's remaining tests: CaptionStoreTests, SessionControllerTests, ParagraphsTests, ServerMessageTests, HistoryStoreTests, TranscriptDecodingTests, SmokeTest.

- [ ] **Step 6: Rewire the watch target**

`watch/project.yml` — add the package and dependency:

```yaml
packages:
  CaptionCore:
    path: CaptionCore
  CaptionRelay:
    path: ../CaptionRelay
```

and under the `WatchCaptions` target's `dependencies:` add `- package: CaptionRelay`.

Then add `import CaptionRelay` to every watch file that uses a moved type:

```bash
grep -rlE '\b(CallAudio|CallVoice|CallCaptions|CallUpdate|CallClient|decodeCallUpdate|MuLaw|muLawDecode|PCMConverter|Settings\b|LaunchAction|BuildInfo|PhoneAudio|ExportWatcher)' watch/WatchCaptions --include='*.swift' -l
```

For each hit that says `import CaptionCore`, add `import CaptionRelay` below it (keep both — most files use types from both). Build the watch target; let remaining compiler errors point out any file the grep missed.

- [ ] **Step 7: Rewire the iOS target**

`ios/project.yml`: replace the `CaptionCore` package entry with

```yaml
packages:
  CaptionRelay:
    path: ../CaptionRelay
```

and in the `PhoneCaptionsUpload` target change `- package: CaptionCore` to `- package: CaptionRelay`. In `ios/PhoneCaptionsUpload/SampleHandler.swift`, `ios/Shared/PresenceWatcher.swift`, `ios/Shared/RelayUploader.swift`: change `import CaptionCore` → `import CaptionRelay` (they use only `PCMConverter` and `PhoneAudio.sessionID`, both now in CaptionRelay). Verify nothing else under `ios/` imports CaptionCore: `grep -rn "import CaptionCore" ios/` → expect no matches after the three edits.

- [ ] **Step 8: Full gate, commit**

Run the full gate (mac is untouched but run it anyway).

```bash
git add -A
git commit -m "refactor: split relay-shaped types into a CaptionRelay package

CaptionCore keeps the session engine (store, controller, paragraphs,
TranscriptSegment); everything watch/iOS-specific moves to a repo-local
package. iOS now depends only on CaptionRelay."
```

---

### Task 3: Slim the mac app to on-device-only

Deletes the relay-backed half of the mac app while it still lives in the monorepo. After this task the mac app has no network code and one engine.

**Files:**
- Delete: `mac/MacCaptions/WebSocketRelay.swift`, `mac/MacCaptions/RelayAPI.swift`, `mac/MacCaptions/TranscriptsView.swift`, `mac/MacCaptions/UsageView.swift`, `mac/MacCaptionsTests/ReconnectPolicyTests.swift`
- Modify: `mac/MacCaptions/SettingsStore.swift`, `mac/MacCaptions/AppModel.swift`, `mac/MacCaptions/MacCaptionsApp.swift`, `mac/MacCaptions/CaptionPanel.swift`

**Interfaces:**
- Consumes: `SessionController(store:relay:audio:permission:)`, `CaptionStore`, `LocalSpeechRelay` — all unchanged by Task 2.
- Produces: `AppModel` with `toggle()`, `pauseResume()`, `showPanel()`, `start()`, `pause()`, `stop()`, published `capturing`, `micOn`, `systemOn`, and singular `store` (no `sessions` array); `SettingsStore` with only `fontSize`. Tasks 10–14 build on exactly this surface.

- [ ] **Step 1: Delete the relay-backed files**

```bash
git rm mac/MacCaptions/{WebSocketRelay,RelayAPI,TranscriptsView,UsageView}.swift mac/MacCaptionsTests/ReconnectPolicyTests.swift
```

- [ ] **Step 2: Rewrite `SettingsStore.swift`** (full replacement — the Keychain, relay URL, provider enum, and compare toggle all go):

```swift
import Foundation

/// Overlay preferences, UserDefaults-backed.
final class SettingsStore: ObservableObject {
    static let defaultFontSize: Double = 18

    /// Overlay caption text size in points.
    @Published var fontSize: Double {
        didSet { UserDefaults.standard.set(fontSize, forKey: "captionFontSize") }
    }

    init() {
        let storedSize = UserDefaults.standard.double(forKey: "captionFontSize")
        fontSize = storedSize > 0 ? storedSize : Self.defaultFontSize
    }
}
```

- [ ] **Step 3: Rewrite `AppModel.swift`** (full replacement — one engine, one session, no `ProviderSession`):

```swift
import Foundation
import Combine
import CaptionCore

@MainActor
final class AppModel: ObservableObject {
    let store = CaptionStore()
    let settings = SettingsStore()
    @Published private(set) var capturing = false
    @Published var micOn = true
    @Published var systemOn = true

    private var hub: AudioHub?
    private var controller: SessionController?
    private let panel = CaptionPanelController()
    private var stateObservation: AnyCancellable?

    init() {
        observeStore()
        AppDelegate.onReopen = { [weak self] in self?.showPanel() }
    }

    func toggle() {
        capturing ? stop() : start()
    }

    /// Overlay ▶/⏸ control: pause ends the session (a new one starts on
    /// resume — the recognizer has no idle mode), but the panel stays up.
    func pauseResume() {
        capturing ? pause() : start()
    }

    /// Show the overlay without starting capture (Spotlight/Finder reopen).
    func showPanel() {
        panel.show(model: self)
    }

    func start() {
        guard !capturing else { return }
        panel.show(model: self)
        let hub = AudioHub(capture: DualCapture(
            micEnabled: { [weak self] in self?.micOn ?? false },
            systemEnabled: { [weak self] in self?.systemOn ?? false }))
        self.hub = hub
        let controller = SessionController(
            store: store, relay: LocalSpeechRelay(), audio: hub.makeTap(),
            permission: MacPermissions())
        self.controller = controller
        capturing = true
        Task { await controller.start() }
    }

    func pause() {
        controller?.stop()
        controller = nil
        hub = nil
        capturing = false
    }

    func stop() {
        pause()
        panel.hide()
    }

    /// Reflect the store's truth: an errored session counts as ended, but the
    /// panel stays up so the user actually sees why — it's only dismissed by
    /// an explicit stop().
    private func observeStore() {
        stateObservation = store.$state.sink { [weak self] state in
            guard let self, case .error = state else { return }
            self.capturing = false
            self.controller?.stop()
            self.controller = nil
            self.hub = nil
        }
    }
}
```

- [ ] **Step 4: Slim `MacCaptionsApp.swift`**

Remove: the `Usage…` and `Transcripts…` menu buttons, both `Window` scenes (`transcripts`, `usage`), and the now-unused `@Environment(\.openWindow)`. In `SettingsView`, remove the whole `Section("Relay")` and, from `Section("Captions")`, the provider `Picker`, its `.disabled`, the `Toggle("Compare all providers", …)`, and the explanatory `Text`. Keep the text-size slider row exactly as is. Keep `StatusLine`, the Start/Stop button, the Microphone/System Audio toggles, `Settings…`, and `Quit`.

- [ ] **Step 5: Slim `CaptionPanel.swift`**

In `CaptionPanelView.body`, delete the `if model.sessions.count > 1 { … } else { … }` branch and keep only the single-store path as the whole `Group` content:

```swift
        Group {
            CaptionFlow(store: store, fontSize: settings.fontSize)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
        }
```

(`CaptionFlow` and everything else in the file is unchanged.)

- [ ] **Step 6: Build, test, commit**

`cd mac && xcodegen generate && xcodebuild test …` (full command in Global Constraints). Expected: builds; `SmokeTest` + 4 `InterleaverTests` pass; `ReconnectPolicyTests` gone. Also run the CaptionCore suite (untouched, but cheap).

```bash
git add -A
git commit -m "feat(mac): slim to on-device captions only

WebSocketRelay, RelayAPI, Transcripts and Usage windows, the provider
picker, compare mode, and the relay settings all go. LocalSpeechRelay is
the only engine; SettingsStore keeps just the text size."
```

---

### Task 4: Move prefill out of SessionController

`SessionController` loses `history:` and the restore logic; a new `TranscriptPrefiller` in CaptionRelay carries the generation guard, reconstructed from core's new `sessionToken`/`isRunning`.

**Files:**
- Modify: `watch/CaptionCore/Sources/CaptionCore/SessionController.swift`, `watch/CaptionCore/Tests/CaptionCoreTests/SessionControllerTests.swift`, `watch/WatchCaptions/AppModel.swift`
- Create: `CaptionRelay/Sources/CaptionRelay/TranscriptPrefiller.swift`, `CaptionRelay/Tests/CaptionRelayTests/TranscriptPrefillerTests.swift`

**Interfaces:**
- Consumes: `HistoryClient` (still in core until Task 6), `CaptionStore.prepend(_: [TranscriptSegment])`.
- Produces (core): `SessionController.init(store:relay:audio:permission:)` (no `history:`), `public private(set) var sessionToken: UUID` (regenerated on every start, stop, and connection loss), `public var isRunning: Bool`. `start(mode:)` keeps its mode parameter until Task 6.
- Produces (CaptionRelay): `TranscriptPrefiller.init(history: HistoryClient)`, `restore(name: String, into: CaptionStore, for: SessionController)`, `cancel()`, internal `waitForRestore() async` for tests.

- [ ] **Step 1: Write the failing TranscriptPrefiller tests**

`CaptionRelay/Tests/CaptionRelayTests/TranscriptPrefillerTests.swift`. Copy the `FakeRelay`, `FakeAudio`, `FakePermission`, and gated/failing history fakes from `watch/CaptionCore/Tests/CaptionCoreTests/SessionControllerTests.swift` into this file (they are `private` there; this module needs its own copies — read that file first and port them verbatim, adding `import CaptionCore` / `@testable import CaptionRelay`). Then port the four prefill behaviors as prefiller tests:

```swift
@MainActor
final class TranscriptPrefillerTests: XCTestCase {
    // Helper: a started controller with fakes, mirroring the old tests' setup.
    private func startedController(store: CaptionStore) async -> SessionController { … }

    func testRestorePrependsTheFetchedSegments() async {
        // history.detail(name:) returns segments -> after waitForRestore,
        // store.paragraphs reflects the prepended transcript.
    }

    func testAFailedRestoreLeavesTheStoreUntouched() async {
        // throwing HistoryClient -> waitForRestore -> no prepend, no error state.
    }

    func testASessionStoppedDuringTheRestoreIsNotPrefilled() async {
        // gated history; controller.stop() before opening the gate ->
        // waitForRestore -> store untouched.
    }

    func testAStaleRestoreDoesNotLandInALaterSession() async {
        // gated history; stop, then start a NEW session (new sessionToken),
        // then open the gate -> the old fetch's result is dropped.
    }
}
```

Write real bodies (the old tests in `SessionControllerTests.swift` are the reference — same assertions, with `prefiller.restore(name:into:for:)` standing where `start(mode: .saved(resuming:))` stood, and `prefiller.waitForRestore()` where `waitForPrefill()` stood). Two old tests die instead of moving, with a comment in the commit message: `testLiveModeRestoresNoTranscript` (the type system now enforces it — restore takes a name; the live path never calls it) and `testResumingWithoutAHistoryClientStillRuns` (a prefiller always has a client; the app simply doesn't construct one without).

- [ ] **Step 2: Run to verify failure**

`cd CaptionRelay && swift test` — expected: FAIL, `TranscriptPrefiller` not defined.

- [ ] **Step 3: Implement `TranscriptPrefiller`**

`CaptionRelay/Sources/CaptionRelay/TranscriptPrefiller.swift`:

```swift
import Foundation
import CaptionCore

/// Restores a resumed transcript's scrollback behind a running session.
///
/// Deliberately not awaited by callers: the captions screen appears at once
/// and the history fills in behind it. A failure is dropped — an error banner
/// over a working session would be worse than missing scrollback.
@MainActor
public final class TranscriptPrefiller {
    private let history: HistoryClient
    /// Retained so tests can await the restore. The app never waits on it.
    private var task: Task<Void, Never>?
    /// The restore a newer one superseded. Tests only, like the original.
    private var supersededTask: Task<Void, Never>?

    public init(history: HistoryClient) {
        self.history = history
    }

    /// Put `name`'s transcript back in `controller`'s store — unless that
    /// session has ended by the time the fetch returns. The token captured
    /// here is the same guard the controller uses internally: `cancel()` is
    /// only a best-effort request, so a fetch already in flight can complete
    /// after its session ended, and `isRunning` alone cannot tell that
    /// session apart from a later one.
    public func restore(name: String, into store: CaptionStore,
                        for controller: SessionController) {
        supersededTask = task
        let token = controller.sessionToken
        task = Task { [weak controller] in
            guard let segments = try? await history.detail(name: name).segments else { return }
            guard let controller, controller.isRunning,
                  controller.sessionToken == token else { return }
            store.prepend(segments)
        }
    }

    public func cancel() {
        task?.cancel()
        task = nil
    }

    /// Awaits the current restore and one a later `restore` superseded.
    /// Tests only — production never waits on either.
    func waitForRestore() async {
        await supersededTask?.value
        await task?.value
    }
}
```

- [ ] **Step 4: Reshape `SessionController`**

In `watch/CaptionCore/Sources/CaptionCore/SessionController.swift`:
- Delete: the `history` property and init parameter, `prefillTask`, `supersededPrefillTask`, `restorePreviousTranscript(named:)`, `waitForPrefill()`, and the `if case .saved(let name?) = mode { restorePreviousTranscript… }` line in `start`.
- Replace the private `generation: Int` with a public token, keeping the guard semantics:

```swift
    /// Identifies the current session across suspension points. Regenerated
    /// whenever a session starts or ends, so work an earlier session started
    /// (a history restore, a stale callback) can recognize the world has
    /// moved on and drop its result. `stop()` is only a best-effort signal —
    /// a fetch already in flight can still complete afterwards, so
    /// `isRunning` alone cannot tell one session from the next.
    public private(set) var sessionToken = UUID()
    /// True while a session is running; pairs with `sessionToken` to let
    /// code outside the controller guard async work the way it does.
    public var isRunning: Bool { running }
```

Every `generation += 1` becomes `sessionToken = UUID()`; the local `let generation = self.generation` / `self.generation == generation` pair in `start` becomes `let token = sessionToken` / `sessionToken == token`.

- [ ] **Step 5: Trim `SessionControllerTests` and add the token test**

Remove the moved/dead prefill tests (`testLiveModeRestoresNoTranscript`, `testResumingRestoresThePreviousTranscript`, `testANewSessionRestoresNothing`, `testAFailedRestoreLeavesTheSessionRunning`, `testASessionStoppedDuringTheRestoreIsNotPrefilled`, `testResumingWithoutAHistoryClientStillRuns`, `testAStaleRestoreDoesNotLandInALaterSession`) and the now-unused history fakes and `waitForPrefill` uses. Keep every other test as-is (the mode tests still pass — mode moves in Task 6). Add:

```swift
    func testSessionTokenChangesAcrossStartAndStop() async {
        // token before start != after start != after stop
    }
```

- [ ] **Step 6: Wire the watch app**

In `watch/WatchCaptions/AppModel.swift`:
- The controller construction (around line 90) loses `history: historyClient`.
- Add a property `private let prefiller: TranscriptPrefiller`, initialized in `init` as `TranscriptPrefiller(history: historyClient)` (same `historyClient` already constructed there).
- In `startCaptions(mode:)`, after `await controller.start(mode: mode)` add:

```swift
        if case .saved(let name?) = mode, controller.isRunning {
            prefiller.restore(name: name, into: store, for: controller)
        }
```

- In `endCapture()` add `prefiller.cancel()` alongside the existing teardown.

- [ ] **Step 7: Run everything, commit**

Full gate. Expected: all green; CaptionRelay now runs TranscriptPrefillerTests.

```bash
git add -A
git commit -m "refactor(core): move transcript prefill out of SessionController

The controller exposes sessionToken/isRunning; a TranscriptPrefiller in
CaptionRelay reconstructs the generation guard on top of them. Two tests
die rather than move: the type system now enforces what they asserted."
```

---

### Task 5: Rename ServerMessage → CaptionEvent, delete the dead wire decoding

**Files:**
- Rename: `watch/CaptionCore/Sources/CaptionCore/ServerMessage.swift` → `CaptionEvent.swift`
- Modify: every file referencing `ServerMessage` (core: CaptionStore, SessionController; CaptionRelay: CallCaptions; watch: HTTPRelayClient and any view/test; mac: LocalSpeechRelay; tests in both packages)
- Delete: the `Decodable` extension + `static func decode` in the renamed file; `watch/CaptionCore/Tests/CaptionCoreTests/ServerMessageTests.swift`

**Interfaces:**
- Consumes: Task 2's module layout.
- Produces: `public enum CaptionEvent: Equatable { case ready; case caption(text: String, isFinal: Bool, channel: Int?); case error(message: String) }` — no Codable. All conformers/consumers updated.

- [ ] **Step 1: Verify the decoding is dead**

```bash
git grep -n "ServerMessage.decode" -- '*.swift'
```

Expected: exactly one match — `ServerMessageTests.swift` (the other historical consumer, mac's `WebSocketRelay`, was deleted in Task 3). If any OTHER file appears, STOP — the deletion below is wrong and the spec's premise needs rechecking.

- [ ] **Step 2: Rename and delete**

```bash
git mv watch/CaptionCore/Sources/CaptionCore/ServerMessage.swift watch/CaptionCore/Sources/CaptionCore/CaptionEvent.swift
git rm watch/CaptionCore/Tests/CaptionCoreTests/ServerMessageTests.swift
```

In `CaptionEvent.swift`: rename the enum to `CaptionEvent`, update its doc comment to `/// An event produced by a captioning engine.`, and delete the entire `extension ServerMessage: Decodable { … }` and `public extension ServerMessage { static func decode … }` blocks.

- [ ] **Step 3: Mechanical rename across the tree**

```bash
git grep -l 'ServerMessage' -- '*.swift' | xargs sed -i '' 's/ServerMessage/CaptionEvent/g'
git grep -n 'ServerMessage' || true   # expect: no matches
```

(iOS has zero occurrences — verified. The sed touches core, CaptionRelay, watch, mac, and tests.)

- [ ] **Step 4: Full gate, commit**

```bash
git add -A
git commit -m "refactor(core): ServerMessage becomes CaptionEvent, wire decoding dies

The Decodable conformance's only consumer was mac's WebSocketRelay,
already deleted; the watch parses the wire with JSONSerialization."
```

---

### Task 6: Rename Relay → CaptionEngine, move mode to the relay, move SessionMode + History out of core

The last reshape step: core stops knowing a relay exists.

**Files:**
- Modify: `watch/CaptionCore/Sources/CaptionCore/Protocols.swift`, `SessionController.swift`, `watch/WatchCaptions/HTTPRelayClient.swift`, `watch/WatchCaptions/AppModel.swift`, `mac/MacCaptions/LocalSpeechRelay.swift`, `watch/CaptionCore/Tests/CaptionCoreTests/SessionControllerTests.swift`, `CaptionRelay/Tests/CaptionRelayTests/TranscriptPrefillerTests.swift`
- Move: `watch/CaptionCore/Sources/CaptionCore/SessionMode.swift` and `History.swift` → `CaptionRelay/Sources/CaptionRelay/`; `watch/CaptionCore/Tests/CaptionCoreTests/{HistoryStoreTests,TranscriptDecodingTests}.swift` → `CaptionRelay/Tests/CaptionRelayTests/`

**Interfaces:**
- Consumes: everything above.
- Produces (core, final shape):

```swift
/// A captioning engine: audio in, caption events out. Callbacks on the main actor.
public protocol CaptionEngine: AnyObject {
    var onEvent: (@MainActor (CaptionEvent) -> Void)? { get set }
    var onClose: (@MainActor () -> Void)? { get set }
    func start()
    func send(_ audio: Data)
    func close()
}
```

  and `SessionController.start()` (parameterless, async), `init(store:relay:audio:permission:)` with `relay: CaptionEngine`.
- Produces (watch): `HTTPRelayClient.mode: SessionMode` — a settable property, default `.saved(resuming: nil)`, read once per `start()`.

- [ ] **Step 1: Core protocol**

In `Protocols.swift`: rename `Relay` → `CaptionEngine`, `onMessage` → `onEvent`, replace `func connect(mode: SessionMode)` with `func start()`, and replace the protocol doc comment with the one above (the old one says "Transport to the caption relay"). `AudioCapturing`/`MicPermissionProviding` unchanged.

In `SessionController.swift`: property/param type `Relay` → `CaptionEngine`, `relay.onMessage` → `relay.onEvent`, `start(mode: SessionMode = .saved(resuming: nil))` → `start()`, `relay.connect(mode: mode)` → `relay.start()`.

- [ ] **Step 2: Move SessionMode and History to CaptionRelay**

```bash
git mv watch/CaptionCore/Sources/CaptionCore/SessionMode.swift CaptionRelay/Sources/CaptionRelay/
git mv watch/CaptionCore/Sources/CaptionCore/History.swift CaptionRelay/Sources/CaptionRelay/
git mv watch/CaptionCore/Tests/CaptionCoreTests/HistoryStoreTests.swift CaptionRelay/Tests/CaptionRelayTests/
git mv watch/CaptionCore/Tests/CaptionCoreTests/TranscriptDecodingTests.swift CaptionRelay/Tests/CaptionRelayTests/
```

`History.swift` needs `import CaptionCore` added (it uses `TranscriptSegment` and `parseISODate`, both in core). The moved tests: `@testable import CaptionCore` → `@testable import CaptionRelay` (+ `import CaptionCore` if the compiler asks). `TranscriptPrefiller` already imports CaptionCore; it now also uses the co-located `HistoryClient` — no import change needed within its own module.

- [ ] **Step 3: Watch conformer + call sites**

`HTTPRelayClient.swift`:
- Conformance `Relay` → `CaptionEngine`; `onMessage` → `onEvent` (and the `emit` helper that calls it).
- Replace `func connect(mode: SessionMode)` with:

```swift
    /// What the next session does with what it hears. Set before `start()`;
    /// read once per connect, so changing it mid-session affects nothing
    /// until the next one — the same lifecycle the old parameter had.
    var mode: SessionMode = .saved(resuming: nil)

    func start() {
        let mode = self.mode
        queue.async { [weak self] in
            …existing body unchanged, switching on the captured `mode`…
        }
    }
```

`AppModel.swift` (watch):
- The phone-audio relay is currently constructed inline in the `phoneController` initializer — hoist it into a local so its mode can be set before the controller captures it (its mode is `.live` forever, so no stored property is needed):

```swift
        let phoneRelay = HTTPRelayClient(
            base: base, token: Secrets.authToken,
            fixedSessionID: PhoneAudio.sessionID)
        phoneRelay.mode = .live
        phoneController = SessionController(
            store: store, relay: phoneRelay,
            audio: SilentCapture(), permission: NoMicNeeded())
```

- `await phoneController.start(mode: .live)` → `await phoneController.start()`.
- In `startCaptions(mode:)`: set `relay.mode = mode` immediately before `await controller.start()` (this is the one call site the spec's temporal-coupling note refers to).
- Any other `RelayCaptionEngine`-type references the Task 5 sed may have produced: none — the sed renamed `ServerMessage` only. But `HTTPRelayClient`'s doc comment says "`Relay` over plain HTTP" — update to "`CaptionEngine` over plain HTTP".

- [ ] **Step 4: Mac conformer**

`LocalSpeechRelay.swift`: conformance `NSObject, Relay` → `NSObject, CaptionEngine`; `onMessage` → `onEvent`; `func connect(mode _: SessionMode)` → `func start()` (drop the now-pointless comment about mode carrying nothing); the file keeps its name until Task 10 renames it in its own repo.

- [ ] **Step 5: Tests**

`SessionControllerTests.swift`: `FakeRelay` conforms to `CaptionEngine` (`onEvent`, `start()`); delete its captured `mode` property. Delete the three mode-forwarding tests whose subject no longer exists: `testLiveModeReachesTheRelay`, `testStartPassesTheTranscriptToResumeToTheRelay`, `testStartWithoutResumeAsksForAFreshTranscript`. `testLiveModeStillCapturesAudio` → plain `start()` (rename to `testARunningSessionCapturesAudio` if the old name now lies). `testASupersededStartDoesNotConnect`: drop its final `relay.mode` assertion, keep the lifecycle assertions. `TranscriptPrefillerTests`' fakes get the same conformance updates.

- [ ] **Step 6: Full gate, commit**

Also: `git grep -nE '\b(Relay\b|onMessage|connect\(mode)' -- watch/CaptionCore CaptionRelay/Sources` → expect no matches in core; `HTTPRelayClient`/`RelayHistoryClient`/`RelaySettingsClient`/`RelayUploader` names elsewhere are fine (app-level names, not the protocol).

```bash
git add -A
git commit -m "refactor(core): Relay becomes CaptionEngine and forgets the relay

start() is parameterless; SessionMode moves to CaptionRelay and lives as
a property on HTTPRelayClient, set once per session at the single call
site. History moves with it. Core no longer knows a relay exists."
```

---

### Task 7: Land the reshape on main

**Files:** none new — merge + push.

**Interfaces:** Produces the `main` that Tasks 8–9 clone and filter.

- [ ] **Step 1: Merge, gate, push**

```bash
git checkout main
git merge feat/extraction-reshape --no-ff -m "Merge extraction reshape: CaptionRelay split, mac slim, CaptionEngine"
```

Run the FULL gate (all five commands + `cd CaptionRelay && swift test`). Expected: all green. Then:

```bash
git push origin main
```

---

### Task 8: Split caption-core into its own repo

**Files (new repo `/Users/jonyen/Projects/caption-core`):**
- Create: `.gitignore`, `LICENSE`, `README.md`

**Interfaces:**
- Produces: `github.com/jonyen/caption-core`, module `CaptionCore`, tag `0.1.0`. Tasks 9 and 15 depend on this URL + tag existing.

- [ ] **Step 1: Clone fresh and filter**

```bash
cd /Users/jonyen/Projects
git clone --no-local --branch main --single-branch /Users/jonyen/Projects/apple-watch-captions caption-core
cd caption-core
git filter-repo --subdirectory-filter watch/CaptionCore
ls   # expect: Package.swift  Sources  Tests
```

(`--no-local` is required — filter-repo's fresh-clone check trips on hardlinked path clones. `--single-branch` keeps the new repo's history to main only; the extraction session's HEAD is elsewhere.)

- [ ] **Step 2: Repo housekeeping commit**

`.gitignore`:

```
.build/
.swiftpm/
```

`LICENSE`: copy from the monorepo (`cp /Users/jonyen/Projects/apple-watch-captions/LICENSE .`).

`README.md`:

```markdown
# CaptionCore

The captioning engine shared by [apple-watch-captions](https://github.com/jonyen/apple-watch-captions)
and [mac-live-captions](https://github.com/jonyen/mac-live-captions): the
`CaptionEngine` protocol, `CaptionEvent`, the paragraph-building
`CaptionStore`, and the `SessionController` that runs permission → engine →
audio. No transport, no relay — engines live in the consuming apps.

`swift test` runs the suite.
```

```bash
cd /Users/jonyen/Projects/caption-core && swift test   # gate before publishing
git add -A && git commit -m "chore: repo scaffolding for the standalone package"
```

- [ ] **Step 3: Create the GitHub repo, push, tag**

```bash
gh repo create jonyen/caption-core --public --description "Caption engine core shared by Watch Captions and Mac Live Captions"
git remote add origin https://github.com/jonyen/caption-core.git
git push -u origin main
git tag 0.1.0 && git push origin 0.1.0
```

---

### Task 9: Split mac-live-captions into its own repo

**Files (new repo `/Users/jonyen/Projects/mac-live-captions`):**
- Create: `.gitignore`, `LICENSE`
- Modify: `project.yml` (remote CaptionCore)

**Interfaces:**
- Consumes: `github.com/jonyen/caption-core` tag `0.1.0` (Task 8).
- Produces: `github.com/jonyen/mac-live-captions`, building and testing green. Tasks 10–14 work in this repo.

- [ ] **Step 1: Clone fresh and filter**

```bash
cd /Users/jonyen/Projects
git clone --no-local --branch main --single-branch /Users/jonyen/Projects/apple-watch-captions mac-live-captions
cd mac-live-captions
git filter-repo --subdirectory-filter mac
ls   # expect: MacCaptions  MacCaptionsTests  README.md  project.yml
```

- [ ] **Step 2: Point at the remote package**

In `project.yml`, replace

```yaml
packages:
  CaptionCore:
    path: ../watch/CaptionCore
```

with

```yaml
packages:
  CaptionCore:
    url: https://github.com/jonyen/caption-core
    from: 0.1.0
```

(the target's `- package: CaptionCore` line is unchanged).

- [ ] **Step 3: Housekeeping**

`.gitignore`:

```
*.xcodeproj
build/
*.profraw
```

`cp /Users/jonyen/Projects/apple-watch-captions/LICENSE .`

- [ ] **Step 4: Build, test, publish**

```bash
xcodegen generate
xcodebuild test -project Captions.xcodeproj -scheme Captions -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO
git add -A && git commit -m "chore: stand alone — remote CaptionCore, repo scaffolding"
gh repo create jonyen/mac-live-captions --public --description "Fast on-device live captions for macOS in a floating overlay, summoned by a global hotkey"
git remote add origin https://github.com/jonyen/mac-live-captions.git
git push -u origin main
```

---

### Task 10: Rename LocalSpeechRelay → AppleSpeechEngine

(All Tasks 10–14 run in `/Users/jonyen/Projects/mac-live-captions`.)

**Files:**
- Rename: `MacCaptions/LocalSpeechRelay.swift` → `MacCaptions/AppleSpeechEngine.swift`
- Modify: `MacCaptions/AppModel.swift` (the one construction site), `README.md`

**Interfaces:**
- Produces: `final class AppleSpeechEngine: NSObject, CaptionEngine`. Referenced by name in Task 12's AppModel context.

- [ ] **Step 1: Rename**

```bash
git mv MacCaptions/LocalSpeechRelay.swift MacCaptions/AppleSpeechEngine.swift
sed -i '' 's/LocalSpeechRelay/AppleSpeechEngine/g' MacCaptions/AppleSpeechEngine.swift MacCaptions/AppModel.swift
```

Update the class doc comment: it currently says "Apple on-device captioning presented as a `Relay`…" — reword to "Apple on-device captioning as a `CaptionEngine`: `start()` asks for speech-recognition permission and emits `.ready`; `send(_:)` takes interleaved stereo PCM and feeds one recognizer per channel."

- [ ] **Step 2: Rewrite `README.md`** for what the app now is: on-device only, no relay, no transcripts; keep the build/test commands (unchanged scheme `Captions`), the permissions section (mic + Screen Recording + speech recognition), and note captions never leave the machine. Mention the hotkey (Tasks 11–13) as the way in.

- [ ] **Step 3: Build, test, commit**

```bash
xcodegen generate && xcodebuild test -project Captions.xcodeproj -scheme Captions -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO
git add -A && git commit -m "refactor: LocalSpeechRelay becomes AppleSpeechEngine"
```

---

### Task 11: HotkeyBinding — the pure, tested value type

**Files:**
- Create: `MacCaptions/HotkeyBinding.swift`, `MacCaptionsTests/HotkeyBindingTests.swift`

**Interfaces:**
- Produces:

```swift
struct HotkeyBinding: Equatable, Codable {
    var keyCode: UInt32      // kVK_* virtual key code, layout-independent
    var modifiers: UInt32    // Carbon mask: cmdKey | optionKey | controlKey | shiftKey
    var keyLabel: String     // what the recorder saw, e.g. "C" — display only
    static let `default`: HotkeyBinding                    // ⌃⌥⌘C
    var display: String                                     // "⌃⌥⌘C"
    var keyEquivalent: (KeyEquivalent, EventModifiers)?     // SwiftUI menu hint
    static func stored(in defaults: UserDefaults) -> HotkeyBinding?  // nil = disabled
    func store(in defaults: UserDefaults)
    static func storeDisabled(in defaults: UserDefaults)
}
```

  Persistence contract: key absent → `.default` (first launch); stored empty data → `nil` (user cleared it); stored JSON → that binding.

- [ ] **Step 1: Write the failing tests**

`MacCaptionsTests/HotkeyBindingTests.swift`:

```swift
import XCTest
@testable import Captions

final class HotkeyBindingTests: XCTestCase {
    private var defaults: UserDefaults!

    override func setUp() {
        defaults = UserDefaults(suiteName: "HotkeyBindingTests")!
        defaults.removePersistentDomain(forName: "HotkeyBindingTests")
    }

    func testDisplayOrdersModifiersCanonically() {
        // control, option, shift, command — the order macOS renders everywhere
        let b = HotkeyBinding(keyCode: 8, modifiers: UInt32(cmdKey | shiftKey | optionKey | controlKey), keyLabel: "c")
        XCTAssertEqual(b.display, "⌃⌥⇧⌘C")
    }

    func testDefaultIsControlOptionCommandC() {
        XCTAssertEqual(HotkeyBinding.default.display, "⌃⌥⌘C")
    }

    func testRoundTripsThroughDefaults() {
        let b = HotkeyBinding(keyCode: 40, modifiers: UInt32(cmdKey), keyLabel: "K")
        b.store(in: defaults)
        XCTAssertEqual(HotkeyBinding.stored(in: defaults), b)
    }

    func testAbsentMeansDefault() {
        XCTAssertEqual(HotkeyBinding.stored(in: defaults), .default)
    }

    func testClearedMeansNone() {
        HotkeyBinding.storeDisabled(in: defaults)
        XCTAssertNil(HotkeyBinding.stored(in: defaults))
    }
}
```

(`cmdKey` etc. come from `import Carbon.HIToolbox`, added at the top.)

- [ ] **Step 2: Run to verify failure** — `xcodebuild test …` fails: `HotkeyBinding` not defined.

- [ ] **Step 3: Implement**

`MacCaptions/HotkeyBinding.swift`:

```swift
import Foundation
import SwiftUI
import Carbon.HIToolbox

/// A global hotkey: a key plus its modifiers. Pure value — Carbon appears
/// only as the stored bit values, so GlobalHotkey can pass them through and
/// tests never need an event system.
struct HotkeyBinding: Equatable, Codable {
    /// Virtual key code (kVK_*), independent of keyboard layout.
    var keyCode: UInt32
    /// Carbon modifier mask: any of cmdKey, optionKey, controlKey, shiftKey.
    var modifiers: UInt32
    /// The key as the recorder saw it, for display: "C", "5", "⎋"…
    var keyLabel: String

    static let `default` = HotkeyBinding(
        keyCode: UInt32(kVK_ANSI_C),
        modifiers: UInt32(controlKey | optionKey | cmdKey),
        keyLabel: "C")

    /// "⌃⌥⇧⌘C" — modifiers in the order macOS renders them, then the key.
    var display: String {
        var s = ""
        if modifiers & UInt32(controlKey) != 0 { s += "⌃" }
        if modifiers & UInt32(optionKey) != 0 { s += "⌥" }
        if modifiers & UInt32(shiftKey) != 0 { s += "⇧" }
        if modifiers & UInt32(cmdKey) != 0 { s += "⌘" }
        return s + keyLabel.uppercased()
    }

    /// The SwiftUI shape of this binding, for showing it beside the menu
    /// item. Nil when the label isn't a single character SwiftUI can render.
    var keyEquivalent: (KeyEquivalent, EventModifiers)? {
        guard let c = keyLabel.lowercased().first, keyLabel.count == 1 else { return nil }
        var m: EventModifiers = []
        if modifiers & UInt32(cmdKey) != 0 { m.insert(.command) }
        if modifiers & UInt32(optionKey) != 0 { m.insert(.option) }
        if modifiers & UInt32(controlKey) != 0 { m.insert(.control) }
        if modifiers & UInt32(shiftKey) != 0 { m.insert(.shift) }
        return (KeyEquivalent(c), m)
    }

    // MARK: - Persistence
    // Absent key: never configured — the default. Empty data: deliberately
    // cleared — no hotkey. JSON: the stored binding.

    private static let key = "hotkeyBinding"

    static func stored(in defaults: UserDefaults = .standard) -> HotkeyBinding? {
        guard let data = defaults.data(forKey: key) else { return .default }
        guard !data.isEmpty else { return nil }
        return (try? JSONDecoder().decode(HotkeyBinding.self, from: data)) ?? .default
    }

    func store(in defaults: UserDefaults = .standard) {
        defaults.set(try? JSONEncoder().encode(self), forKey: Self.key)
    }

    static func storeDisabled(in defaults: UserDefaults = .standard) {
        defaults.set(Data(), forKey: key)
    }
}
```

- [ ] **Step 4: Run tests to verify pass, commit**

```bash
git add -A && git commit -m "feat: HotkeyBinding value type with display and persistence"
```

---

### Task 12: GlobalHotkey — Carbon registration wired to toggle()

**Files:**
- Create: `MacCaptions/GlobalHotkey.swift`
- Modify: `MacCaptions/SettingsStore.swift` (add `hotkey`), `MacCaptions/AppModel.swift` (own a GlobalHotkey), `MacCaptions/MacCaptionsApp.swift` (menu hint)

**Interfaces:**
- Consumes: `HotkeyBinding` (Task 11), `AppModel.toggle()` (Task 3).
- Produces: `GlobalHotkey.init(onPress:)`, `register(_ binding: HotkeyBinding)`, `unregister()`; `SettingsStore.hotkey: HotkeyBinding?` (`@Published`, persisted). Task 13's recorder writes `settings.hotkey`.

- [ ] **Step 1: Implement `GlobalHotkey`**

`MacCaptions/GlobalHotkey.swift`:

```swift
import Foundation
import Carbon.HIToolbox

/// One system-wide hotkey via Carbon's RegisterEventHotKey — the only
/// global-hotkey API that needs no Accessibility permission, and it works
/// from an LSUIElement app with no window focused. Not @MainActor so deinit
/// can clean up; the callback is bounced to the main queue instead.
final class GlobalHotkey {
    private var hotKeyRef: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?
    private let onPress: () -> Void

    init(onPress: @escaping () -> Void) {
        self.onPress = onPress
    }

    func register(_ binding: HotkeyBinding) {
        unregister()
        var eventType = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(
            GetApplicationEventTarget(),
            { _, _, userData in
                guard let userData else { return noErr }
                let hotkey = Unmanaged<GlobalHotkey>.fromOpaque(userData).takeUnretainedValue()
                DispatchQueue.main.async { hotkey.onPress() }
                return noErr
            },
            1, &eventType,
            Unmanaged.passUnretained(self).toOpaque(),
            &handlerRef)
        let id = EventHotKeyID(signature: OSType(0x4350_544E) /* 'CPTN' */, id: 1)
        RegisterEventHotKey(binding.keyCode, binding.modifiers, id,
                            GetApplicationEventTarget(), 0, &hotKeyRef)
    }

    func unregister() {
        if let hotKeyRef { UnregisterEventHotKey(hotKeyRef); self.hotKeyRef = nil }
        if let handlerRef { RemoveEventHandler(handlerRef); self.handlerRef = nil }
    }

    deinit { unregister() }
}
```

- [ ] **Step 2: SettingsStore gains the binding**

Add to `SettingsStore`:

```swift
    /// The global hotkey; nil disables it. Absent-vs-cleared lives in
    /// HotkeyBinding's persistence, so first launch gets the default.
    @Published var hotkey: HotkeyBinding? {
        didSet {
            if let hotkey { hotkey.store() } else { HotkeyBinding.storeDisabled() }
        }
    }
```

and in `init()`: `hotkey = HotkeyBinding.stored()`.

- [ ] **Step 3: AppModel owns the registration**

Add to `AppModel`:

```swift
    private var hotkey: GlobalHotkey?
    private var hotkeyObservation: AnyCancellable?
```

and in `init()`:

```swift
        hotkey = GlobalHotkey { [weak self] in self?.toggle() }
        hotkeyObservation = settings.$hotkey.sink { [weak self] binding in
            if let binding { self?.hotkey?.register(binding) }
            else { self?.hotkey?.unregister() }
        }
```

(`sink` on a `@Published` fires with the initial value, so launch registers the stored binding without extra code.)

- [ ] **Step 4: Menu hint**

In `MacCaptionsApp`'s menu, give the Start/Stop button the binding as its native shortcut hint:

```swift
            if let (key, mods) = model.settings.hotkey?.keyEquivalent {
                Button(model.capturing ? "Stop Captions" : "Start Captions") { model.toggle() }
                    .keyboardShortcut(key, modifiers: mods)
            } else {
                Button(model.capturing ? "Stop Captions" : "Start Captions") { model.toggle() }
            }
```

(The menu renders the combo the way every macOS menu does; the *global* trigger is Carbon — this is display plus an in-menu shortcut, and a comment in the code should say so.)

- [ ] **Step 5: Build, test, commit**

Unit tests can't press keys — verification of the actual global press happens in Task 14's checklist. Gate: build + existing tests green.

```bash
git add -A && git commit -m "feat: global hotkey toggles captions from anywhere

Carbon RegisterEventHotKey — permission-free, works for an LSUIElement
app. Default ⌃⌥⌘C; the menu shows the current combo."
```

---

### Task 13: HotkeyRecorderField — record a custom combo in Settings

**Files:**
- Create: `MacCaptions/HotkeyRecorderField.swift`
- Modify: `MacCaptions/MacCaptionsApp.swift` (SettingsView row)

**Interfaces:**
- Consumes: `SettingsStore.hotkey` (Task 12).
- Produces: `HotkeyRecorderField(hotkey: Binding<HotkeyBinding?>)` — click to focus, press a combo to record, Escape cancels, Delete clears.

- [ ] **Step 1: Implement the recorder**

`MacCaptions/HotkeyRecorderField.swift`:

```swift
import SwiftUI
import AppKit
import Carbon.HIToolbox

/// A click-to-record hotkey field. Click it, press a combo, done.
/// Escape drops focus without recording; Delete clears the binding.
struct HotkeyRecorderField: NSViewRepresentable {
    @Binding var hotkey: HotkeyBinding?

    func makeNSView(context: Context) -> RecorderView {
        let view = RecorderView()
        view.onCapture = { hotkey = $0 }
        view.onClear = { hotkey = nil }
        view.display = { hotkey?.display }
        return view
    }

    func updateNSView(_ view: RecorderView, context: Context) {
        view.needsDisplay = true
    }

    final class RecorderView: NSView {
        var onCapture: ((HotkeyBinding) -> Void)?
        var onClear: (() -> Void)?
        var display: (() -> String?)?

        override var acceptsFirstResponder: Bool { true }
        override var intrinsicContentSize: NSSize { NSSize(width: 120, height: 24) }

        override func mouseDown(with event: NSEvent) {
            window?.makeFirstResponder(self)
        }

        override func keyDown(with event: NSEvent) {
            switch Int(event.keyCode) {
            case kVK_Escape:
                window?.makeFirstResponder(nil)
            case kVK_Delete, kVK_ForwardDelete:
                onClear?()
                window?.makeFirstResponder(nil)
            default:
                var carbon: UInt32 = 0
                let mods = event.modifierFlags
                if mods.contains(.command) { carbon |= UInt32(cmdKey) }
                if mods.contains(.option) { carbon |= UInt32(optionKey) }
                if mods.contains(.control) { carbon |= UInt32(controlKey) }
                if mods.contains(.shift) { carbon |= UInt32(shiftKey) }
                // A bare key makes a terrible global hotkey — it would fire
                // while typing. Require at least one modifier.
                guard carbon != 0 else { NSSound.beep(); return }
                let label = event.charactersIgnoringModifiers?.uppercased() ?? "?"
                onCapture?(HotkeyBinding(
                    keyCode: UInt32(event.keyCode), modifiers: carbon, keyLabel: label))
                window?.makeFirstResponder(nil)
            }
        }

        override func draw(_ dirtyRect: NSRect) {
            let recording = window?.firstResponder === self
            let text = recording ? "Press keys…" : (display?() ?? "None")
            let color: NSColor = recording ? .secondaryLabelColor : .labelColor
            NSColor.controlBackgroundColor.setFill()
            let box = NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 5, yRadius: 5)
            box.fill()
            (recording ? NSColor.keyboardFocusIndicatorColor : .separatorColor).setStroke()
            box.stroke()
            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 12), .foregroundColor: color]
            let size = text.size(withAttributes: attrs)
            text.draw(at: NSPoint(x: (bounds.width - size.width) / 2,
                                  y: (bounds.height - size.height) / 2), withAttributes: attrs)
        }

        override func becomeFirstResponder() -> Bool { needsDisplay = true; return super.becomeFirstResponder() }
        override func resignFirstResponder() -> Bool { needsDisplay = true; return super.resignFirstResponder() }
    }
}
```

- [ ] **Step 2: Settings row**

In `SettingsView`'s `Section("Captions")`, above the text-size row:

```swift
                LabeledContent("Global shortcut") {
                    HotkeyRecorderField(hotkey: $settings.hotkey)
                        .fixedSize()
                }
                Text("Toggles captions from any app. Delete clears it.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
```

- [ ] **Step 3: Build, test, commit**

```bash
xcodegen generate && xcodebuild test -project Captions.xcodeproj -scheme Captions -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO
git add -A && git commit -m "feat: record a custom hotkey in Settings"
```

---

### Task 14: Launch at login + manual verification + final push

**Files:**
- Modify: `MacCaptions/SettingsStore.swift`, `MacCaptions/MacCaptionsApp.swift`, `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the finished app, pushed.

- [ ] **Step 1: Launch-at-login in SettingsStore**

```swift
import ServiceManagement
```

and:

```swift
    /// Registered as a login item so the hotkey works after a reboot —
    /// a global hotkey only fires while the app is running.
    @Published var launchAtLogin: Bool {
        didSet {
            guard !revertingLoginItem, oldValue != launchAtLogin else { return }
            do {
                if launchAtLogin { try SMAppService.mainApp.register() }
                else { try SMAppService.mainApp.unregister() }
            } catch {
                // Reflect reality: the toggle failed, so put it back.
                revertingLoginItem = true
                launchAtLogin = oldValue
                revertingLoginItem = false
            }
        }
    }
    private var revertingLoginItem = false
```

`init()` gains: `launchAtLogin = SMAppService.mainApp.status == .enabled`.

- [ ] **Step 2: Settings toggle**

In `SettingsView`, a new section below Captions:

```swift
            Section("General") {
                Toggle("Launch at login", isOn: $settings.launchAtLogin)
                Text("Keeps the global shortcut working after a restart.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
```

- [ ] **Step 3: Build + run the manual checklist**

Build and launch the app (`xcodebuild build …` then `open` the product, or run from Xcode). Verify and record actual results — report what happened, not what should have:

1. Menu bar icon appears; Start Captions shows `⌃⌥⌘C` beside it.
2. Focus another app entirely; press ⌃⌥⌘C → the overlay appears and mic captions stream (first run prompts for mic + speech recognition; grant and retry).
3. Press ⌃⌥⌘C again → capture stops.
4. Settings → record a new combo (e.g. ⌃⌥⌘L) → menu hint updates; new combo toggles globally; old one is dead.
5. Settings → focus the recorder, press Delete → shortcut cleared, no global response; re-record.
6. Quit, relaunch → the recorded combo still works (persistence).
7. Toggle Launch at login on → System Settings › General › Login Items lists Captions; toggle off → it leaves.

- [ ] **Step 4: README + push**

Add the hotkey + launch-at-login to `README.md`'s feature list. Then:

```bash
git add -A && git commit -m "feat: launch at login, so the hotkey survives a reboot"
git push origin main
```

---

### Task 15: apple-watch-captions sheds mac/ and CaptionCore

(Back in `/Users/jonyen/Projects/apple-watch-captions`, on `main`.)

**Files:**
- Delete: `mac/` (all), `watch/CaptionCore/` (all)
- Modify: `watch/project.yml`, `CaptionRelay/Package.swift`, `.github/workflows/ci.yml`, `.gitignore`, `README.md`, `docs/superpowers/specs/2026-08-15-multi-tenant-migration-design.md`

**Interfaces:**
- Consumes: `github.com/jonyen/caption-core` `0.1.0` (Task 8).
- Produces: the slimmed monorepo — watch + iOS + backend, depending on caption-core remotely.

- [ ] **Step 1: Delete the extracted trees**

```bash
git rm -rq mac watch/CaptionCore
```

- [ ] **Step 2: Repoint the dependencies**

`watch/project.yml`:

```yaml
packages:
  CaptionCore:
    url: https://github.com/jonyen/caption-core
    from: 0.1.0
  CaptionRelay:
    path: ../CaptionRelay
```

`CaptionRelay/Package.swift` — replace the path dependency:

```swift
    dependencies: [
        .package(url: "https://github.com/jonyen/caption-core", from: "0.1.0"),
    ],
    targets: [
        .target(name: "CaptionRelay",
                dependencies: [.product(name: "CaptionCore", package: "caption-core")]),
        .testTarget(name: "CaptionRelayTests", dependencies: ["CaptionRelay"]),
    ]
```

(For a remote package, SPM's `package:` identifier is the repo name `caption-core`, not the package name — hence the explicit `.product` form.)

- [ ] **Step 3: CI, gitignore, docs, README**

`.github/workflows/ci.yml`: the `caption-core` job's `working-directory` becomes `CaptionRelay`; rename the job `caption-relay`. (Its `swift test` now resolves caption-core from GitHub — fine on hosted runners.)

`.gitignore`: delete the `mac/*.xcodeproj` line; change the two `watch/CaptionCore/…` lines to:

```
CaptionRelay/.build/
CaptionRelay/.swiftpm/
```

`docs/superpowers/specs/2026-08-15-multi-tenant-migration-design.md`: its pointer to `mac/MacCaptions/LocalSpeechRelay.swift` as the on-device reference implementation now reads: `AppleSpeechEngine.swift` in `github.com/jonyen/mac-live-captions` (extraction preserved it with history).

`README.md` (repo root): add a short "Related repos" section linking `jonyen/caption-core` (shared engine core) and `jonyen/mac-live-captions` (the Mac overlay app); remove/adjust any remaining mention of `mac/` (`grep -n "mac/" README.md` and fix what it finds).

- [ ] **Step 4: Gate, commit, push**

```bash
(cd CaptionRelay && swift test)
(cd watch && xcodegen generate && xcodebuild build -project WatchCaptions.xcodeproj -scheme WatchCaptions -destination 'generic/platform=watchOS Simulator' CODE_SIGNING_ALLOWED=NO)
(cd ios && xcodegen generate && xcodebuild build -project PhoneCaptions.xcodeproj -scheme PhoneCaptions -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO)
git add -A
git commit -m "chore: shed mac/ and CaptionCore — extracted to their own repos

caption-core is now a remote dependency; CaptionRelay stays repo-local.
See jonyen/caption-core and jonyen/mac-live-captions."
git push origin main
```

---

## Coverage map (spec → tasks)

| Spec requirement | Task |
|---|---|
| Reconciliation merge, backend wholesale, 9 watch hunks, port-plan repoint | 1 |
| CaptionRelay package; Paragraphs/TranscriptSegment stay in core; parseISODate public | 2 |
| iOS swaps to CaptionRelay only | 2 |
| Mac slim pre-split (relay code, providers, settings fields) | 3 |
| Prefill → TranscriptPrefiller; sessionToken/isRunning | 4 |
| ServerMessage → CaptionEvent; dead Decodable deleted | 5 |
| Relay → CaptionEngine; parameterless start(); HTTPRelayClient.mode; SessionMode/History move | 6 |
| Reshape gate on main | 7 |
| caption-core repo, history, tag 0.1.0 | 8 |
| mac-live-captions repo, history, remote dep | 9 |
| AppleSpeechEngine rename + migration-spec pointer | 10, 15 |
| HotkeyBinding (tested) | 11 |
| GlobalHotkey Carbon, default ⌃⌥⌘C, menu shows binding | 12 |
| Recorder field: record/Escape/Delete | 13 |
| Launch at login; manual hotkey verification | 14 |
| Monorepo sheds mac/ + CaptionCore; CI/gitignore/README | 15 |
