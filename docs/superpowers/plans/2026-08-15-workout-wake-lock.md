# Workout Wake Lock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the Apple Watch display lit for the duration of a captioning session, opted into per session by a remembered toggle.

**Architecture:** A `DisplayWakeLocking` protocol in `CaptionCore` is acquired and released alongside the existing session lifecycle in `SessionController`. The only implementation, `WorkoutWakeLock`, lives in the watch target and runs an `HKWorkoutSession` with no live builder, so nothing is written to Health. `AppModel` owns the remembered toggle and passes it down as `keepAwake`.

**Tech Stack:** Swift 5.9+, SwiftUI, XCTest, HealthKit, XcodeGen (`project.yml`), watchOS 10.0 deployment target.

**Spec:** `docs/superpowers/specs/2026-08-15-workout-wake-lock-design.md`

## Global Constraints

- `CaptionCore` must never import HealthKit. It is a platform-free logic package; HealthKit belongs only to the watch target.
- Never construct an `HKLiveWorkoutBuilder` and never call `finishWorkout()`. Writing a workout to Health is explicitly out of scope.
- Fail open, silently. HealthKit unavailable, denied, or failing to start means: log, keep captioning, let the screen dim. No alerts, no error state, no change to `CaptionStore`.
- The toggle is **off by default**.
- watchOS deployment target is `10.0` (`project.yml`).
- Scope is dimming only. Nothing here attempts to stop wrist-off locking.

## Deviations from the spec

Two, both discovered while reading the code. Adopt them:

1. **`acquire()` is synchronous, not `async`.** The spec shows `func acquire() async`. Making it async adds a suspension point to `SessionController.start` between the permission gate and `relay.connect`, which would need a third generation check to avoid acquiring a lock for a session that already ended. Since the design already fails open silently, `acquire()` has nothing useful to report back — so the implementation owns its own `Task` for the async authorization work and the controller stays synchronous and trivially correct.

2. **Release happens in `handleClose()` as well as `stop()`.** The spec says release lives in `stop()`. Reading `SessionController` shows `handleClose()` (a dropped connection) ends a session *without* going through `stop()`. Releasing only in `stop()` would leave the workout session — and the lit screen — running forever after a connection drop.

3. **Persistence uses `UserDefaults` + a `Keys` entry, not `@AppStorage`.** The spec says `@AppStorage`. `AppModel` already persists `stoppedExplicitly` with a `didSet` writing to an injected `defaults`, and `HomeView` takes plain values and closures rather than bindings. Follow the established pattern.

## File Structure

| File | Responsibility |
|---|---|
| `watch/CaptionCore/Sources/CaptionCore/Protocols.swift` | Modify — add the `DisplayWakeLocking` protocol next to `MicPermissionProviding` |
| `watch/CaptionCore/Sources/CaptionCore/SessionController.swift` | Modify — hold the lock, acquire on start when asked, release on every exit path |
| `watch/CaptionCore/Tests/CaptionCoreTests/SessionControllerTests.swift` | Modify — `FakeWakeLock` and the acquire/release pairing tests |
| `watch/WatchCaptions/WorkoutWakeLock.swift` | Create — the only HealthKit file: authorization, session start, session end |
| `watch/project.yml` | Modify — `workout-processing` background mode, Health usage description, HealthKit entitlement |
| `watch/WatchCaptions/AppModel.swift` | Modify — remembered `keepScreenOn`, inject `WorkoutWakeLock`, pass `keepAwake` |
| `watch/WatchCaptions/Views/HomeView.swift` | Modify — the "Keep screen on" toggle row |

---

### Task 1: The wake-lock seam in CaptionCore

Pure logic, fully unit-tested, no HealthKit. This task is complete and reviewable on its own: the protocol exists, the lifecycle is correct, and nothing yet implements it.

**Files:**
- Modify: `watch/CaptionCore/Sources/CaptionCore/Protocols.swift`
- Modify: `watch/CaptionCore/Sources/CaptionCore/SessionController.swift`
- Test: `watch/CaptionCore/Tests/CaptionCoreTests/SessionControllerTests.swift`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `public protocol DisplayWakeLocking: AnyObject { func acquire(); func release() }`
  - `SessionController.init(store:relay:audio:permission:history:wakeLock:)` where `wakeLock: DisplayWakeLocking? = nil`
  - `SessionController.start(mode:keepAwake:) async` where `keepAwake: Bool = false`

- [ ] **Step 1: Write the failing tests**

Add the fake to `SessionControllerTests`, next to `FakeAudio`:

```swift
    final class FakeWakeLock: DisplayWakeLocking {
        var acquireCount = 0
        var releaseCount = 0
        func acquire() { acquireCount += 1 }
        func release() { releaseCount += 1 }
    }
```

Add a second factory beside the existing `make(granted:history:)` — a separate helper on purpose, since widening `make`'s tuple would break every existing call site:

```swift
    private func makeWaking(granted: Bool = true)
        -> (SessionController, FakeRelay, FakeWakeLock) {
        let relay = FakeRelay()
        let lock = FakeWakeLock()
        let c = SessionController(store: CaptionStore(), relay: relay, audio: FakeAudio(),
                                  permission: FakePermission(granted: granted),
                                  wakeLock: lock)
        return (c, relay, lock)
    }
```

Add the five tests at the end of the class:

```swift
    func testAcquiresTheWakeLockWhenKeepAwakeIsSet() async {
        let (c, _, lock) = makeWaking()
        await c.start(keepAwake: true)
        XCTAssertEqual(lock.acquireCount, 1)
    }

    func testDoesNotAcquireTheWakeLockByDefault() async {
        let (c, relay, lock) = makeWaking()
        await c.start()
        XCTAssertTrue(relay.connected)
        XCTAssertEqual(lock.acquireCount, 0)
    }

    func testReleasesTheWakeLockOnStop() async {
        let (c, _, lock) = makeWaking()
        await c.start(keepAwake: true)
        c.stop()
        XCTAssertEqual(lock.releaseCount, 1)
    }

    /// A dropped connection ends the session without going through `stop()`.
    /// Without its own release the workout session — and the lit screen —
    /// would outlive the session that asked for it.
    func testReleasesTheWakeLockWhenTheConnectionDrops() async {
        let (c, relay, lock) = makeWaking()
        await c.start(keepAwake: true)
        relay.deliver(.ready)
        relay.dropConnection()
        XCTAssertEqual(lock.releaseCount, 1)
    }

    func testDoesNotAcquireTheWakeLockWhenTheMicIsDenied() async {
        let (c, _, lock) = makeWaking(granted: false)
        await c.start(keepAwake: true)
        XCTAssertEqual(lock.acquireCount, 0)
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd watch/CaptionCore && swift test --filter SessionControllerTests`

Expected: FAIL to compile — `DisplayWakeLocking` does not exist, `SessionController.init` has no `wakeLock:` parameter, and `start` has no `keepAwake:` parameter. A compile failure is the correct RED here; the type does not exist yet.

- [ ] **Step 3: Add the protocol**

Append to `Protocols.swift`:

```swift
/// Holds the watch display awake for the length of a session.
///
/// `acquire()` is synchronous by design. The only implementation needs async
/// authorization work, but the controller must not gain a suspension point
/// between the permission gate and `connect` — so the implementation owns that
/// Task. Nothing is reported back because failure is silent by design: a lock
/// that cannot be taken lets the screen dim, and captioning continues.
public protocol DisplayWakeLocking: AnyObject {
    func acquire()
    func release()
}
```

- [ ] **Step 4: Hold and release the lock in SessionController**

In `SessionController`, add the stored property after `private let history: HistoryClient?`:

```swift
    private let wakeLock: DisplayWakeLocking?
```

Extend `init` — append the parameter last, with a default, so every existing call site and test keeps compiling:

```swift
    public init(store: CaptionStore, relay: Relay,
                audio: AudioCapturing, permission: MicPermissionProviding,
                history: HistoryClient? = nil,
                wakeLock: DisplayWakeLocking? = nil) {
```

and assign it alongside the others, before the `relay.onMessage` wiring:

```swift
        self.wakeLock = wakeLock
```

Change the `start` signature and acquire after the generation re-check, immediately before `relay.connect(mode:)`:

```swift
    public func start(mode: SessionMode = .saved(resuming: nil), keepAwake: Bool = false) async {
```

```swift
        guard running, self.generation == generation else { return }
        // After the permission gate and its generation re-check, so a denied
        // mic or a superseded session never takes a lock nothing will release.
        if keepAwake { wakeLock?.acquire() }
        relay.connect(mode: mode)
```

Release on both exit paths. In `stop()`, after `relay.close()`:

```swift
        wakeLock?.release()
```

In `handleClose()`, after `audio.stop()`:

```swift
        wakeLock?.release()
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd watch/CaptionCore && swift test`

Expected: PASS — the five new tests plus every pre-existing test, unchanged.

- [ ] **Step 6: Commit**

```bash
git add watch/CaptionCore/Sources/CaptionCore/Protocols.swift \
        watch/CaptionCore/Sources/CaptionCore/SessionController.swift \
        watch/CaptionCore/Tests/CaptionCoreTests/SessionControllerTests.swift
git commit -m "feat(watch): pair a display wake lock with the session lifecycle"
```

---

### Task 2: The HealthKit implementation and its capability

The one file that imports HealthKit, plus the project configuration it needs. Deliverable is a watch app that still builds with the capability in place — nothing calls this yet.

**Files:**
- Create: `watch/WatchCaptions/WorkoutWakeLock.swift`
- Modify: `watch/project.yml`

**Interfaces:**
- Consumes: `DisplayWakeLocking` from Task 1.
- Produces: `final class WorkoutWakeLock: DisplayWakeLocking`, constructed with `WorkoutWakeLock()`.

- [ ] **Step 1: Add the capability to project.yml**

In the `info.properties` block, extend the existing background modes and add the usage description:

```yaml
        UIBackgroundModes:
          - audio
          # Keeps the display lit while captioning, via a workout session that
          # is never saved. See docs/superpowers/specs/2026-08-15-workout-wake-lock-design.md
          - workout-processing
        NSHealthUpdateUsageDescription: "A workout session keeps the screen awake while captioning. No workout is ever saved."
```

Add an entitlements block to the `WatchCaptions` target, as a sibling of `info:`:

```yaml
    entitlements:
      path: WatchCaptions/WatchCaptions.entitlements
      properties:
        com.apple.developer.healthkit: true
```

- [ ] **Step 2: Write the implementation**

Create `watch/WatchCaptions/WorkoutWakeLock.swift`:

```swift
import Foundation
import HealthKit
import CaptionCore

/// Keeps the watch display lit by running a workout session for the length of a
/// captioning session.
///
/// A workout session is the only thing on watchOS that keeps the screen awake —
/// there is no `isIdleTimerDisabled` equivalent. No `HKLiveWorkoutBuilder` is
/// ever created and `finishWorkout()` is never called, so nothing is written to
/// Health: the lit screen is a property of the running session, not of the data
/// it would otherwise collect.
///
/// Every failure is silent. A session that cannot start means the screen dims,
/// which is exactly what happens today, and an alert over live captions would be
/// worse than the dimming it complained about.
/// Main-actor isolated to match `SessionController`, which is the only caller.
/// That keeps `session` and `startTask` on one actor, so the unstructured Task
/// below — which inherits the main actor — needs no hopping to touch them.
@MainActor
final class WorkoutWakeLock: NSObject, DisplayWakeLocking {
    private let store = HKHealthStore()
    private var session: HKWorkoutSession?
    /// Retained so a release arriving before authorization finishes can cancel it.
    private var startTask: Task<Void, Never>?

    func acquire() {
        guard HKHealthStore.isHealthDataAvailable() else {
            print("[wakelock] health data unavailable; screen will dim")
            return
        }
        guard session == nil, startTask == nil else { return }
        startTask = Task { [weak self] in
            guard let self else { return }
            do {
                try await self.store.requestAuthorization(toShare: [HKObjectType.workoutType()], read: [])
            } catch {
                print("[wakelock] authorization failed: \(error); screen will dim")
                self.startTask = nil
                return
            }
            guard !Task.isCancelled else {
                self.startTask = nil
                return
            }
            self.beginSession()
        }
    }

    func release() {
        startTask?.cancel()
        startTask = nil
        session?.end()
        session = nil
    }

    private func beginSession() {
        startTask = nil
        let configuration = HKWorkoutConfiguration()
        configuration.activityType = .other
        configuration.locationType = .indoor
        do {
            let session = try HKWorkoutSession(healthStore: store, configuration: configuration)
            session.delegate = self
            session.startActivity(with: Date())
            self.session = session
        } catch {
            print("[wakelock] workout session failed to start: \(error); screen will dim")
        }
    }
}

/// The delegate is required for the session to run. Nothing here needs to react
/// to a state change — the session exists only for its side effect on the
/// display — so these are deliberately near-empty.
extension WorkoutWakeLock: HKWorkoutSessionDelegate {
    nonisolated func workoutSession(_ workoutSession: HKWorkoutSession,
                                    didChangeTo toState: HKWorkoutSessionState,
                                    from fromState: HKWorkoutSessionState,
                                    date: Date) {}

    nonisolated func workoutSession(_ workoutSession: HKWorkoutSession,
                                    didFailWithError error: Error) {
        print("[wakelock] workout session failed: \(error); screen will dim")
    }
}
```

- [ ] **Step 3: Regenerate the project and build**

Run:

```bash
cd watch && xcodegen generate && \
xcodebuild -project WatchCaptions.xcodeproj -scheme WatchCaptions \
  -destination 'generic/platform=watchOS' build
```

Expected: BUILD SUCCEEDED. If signing fails on the HealthKit entitlement, open the project in Xcode once so automatic signing can add the capability to the App ID, then re-run.

If HealthKit later refuses to authorize at runtime complaining about a missing `NSHealthShareUsageDescription`, add that key too — do not widen the requested scope to match it. The app reads nothing and must keep reading nothing.

- [ ] **Step 4: Verify CaptionCore stayed platform-free**

Run: `cd watch && grep -rn "HealthKit" CaptionCore/Sources/`

Expected: no output. HealthKit must appear only in the watch target.

- [ ] **Step 5: Commit**

```bash
git add watch/WatchCaptions/WorkoutWakeLock.swift watch/project.yml \
        watch/WatchCaptions/WatchCaptions.entitlements watch/WatchCaptions.xcodeproj
git commit -m "feat(watch): add a workout-backed wake lock that saves nothing"
```

---

### Task 3: The toggle and the wiring

Connects the two halves: a remembered preference, passed into the session that already knows what to do with it.

**Files:**
- Modify: `watch/WatchCaptions/AppModel.swift`
- Modify: `watch/WatchCaptions/Views/HomeView.swift`
- Modify: `watch/WatchCaptions/WatchCaptionsApp.swift`

**Interfaces:**
- Consumes: `SessionController.start(mode:keepAwake:)` and the `wakeLock:` init parameter from Task 1; `WorkoutWakeLock()` from Task 2.
- Produces: `AppModel.keepScreenOn: Bool` (published, persisted); `HomeView(lastSession:onNew:onLive:onContinue:onBrowse:onTakeCall:keepScreenOn:onKeepScreenOnChange:)`.

- [ ] **Step 1: Add the remembered preference to AppModel**

Add the published property beside `stoppedExplicitly`, mirroring its `didSet` persistence:

```swift
    /// Whether the next session should hold the screen awake. Remembered,
    /// because propping the watch on a table is a habit, not a one-off.
    @Published var keepScreenOn = false {
        didSet { defaults.set(keepScreenOn, forKey: Keys.keepScreenOn) }
    }
```

Add its key to the `Keys` enum:

```swift
        static let keepScreenOn = "keepScreenOn"
```

Load it in `init`, next to the existing `stoppedExplicitly` load:

```swift
        keepScreenOn = defaults.bool(forKey: Keys.keepScreenOn)
```

Inject the lock where the controller is built, after `history: historyClient`:

```swift
            history: historyClient,
            wakeLock: WorkoutWakeLock()
```

Pass the flag through in `startCaptions(mode:)`, replacing `await controller.start(mode: mode)`:

```swift
        await controller.start(mode: mode, keepAwake: keepScreenOn)
```

- [ ] **Step 2: Add the toggle row to HomeView**

Add the two properties after `onTakeCall`:

```swift
    /// Whether the next session holds the screen awake.
    let keepScreenOn: Bool
    let onKeepScreenOnChange: (Bool) -> Void
```

Add the row directly below the "Continue last" block and above "Take call", so the session controls stay together:

```swift
            Toggle(isOn: Binding(get: { keepScreenOn }, set: onKeepScreenOnChange)) {
                Label("Keep screen on", systemImage: "sun.max")
            }
```

- [ ] **Step 3: Pass it in from WatchCaptionsApp**

Extend the `HomeView(...)` call:

```swift
                    onTakeCall: { model.takeCall() },
                    keepScreenOn: model.keepScreenOn,
                    onKeepScreenOnChange: { model.keepScreenOn = $0 })
```

- [ ] **Step 4: Build and run in the simulator**

Run:

```bash
cd watch && xcodegen generate && \
xcodebuild -project WatchCaptions.xcodeproj -scheme WatchCaptions \
  -destination 'platform=watchOS Simulator,name=Apple Watch Series 10 (46mm)' build
```

Expected: BUILD SUCCEEDED. Launch it and confirm the toggle appears on the home screen, flips, and survives a relaunch. The simulator will not show the lit-screen behavior — that is Task 4.

If that simulator name does not exist, list the available ones with `xcrun simctl list devicetypes | grep Watch` and substitute.

- [ ] **Step 5: Run the full CaptionCore suite**

Run: `cd watch/CaptionCore && swift test`

Expected: PASS, everything, unchanged from Task 1.

- [ ] **Step 6: Commit**

```bash
git add watch/WatchCaptions/AppModel.swift watch/WatchCaptions/Views/HomeView.swift \
        watch/WatchCaptions/WatchCaptionsApp.swift
git commit -m "feat(watch): add a remembered Keep screen on toggle"
```

---

### Task 4: On-device verification

The claims this feature rests on cannot be tested in the simulator or in a unit test. This task exists to settle them, and its deliverable is a written answer in the spec — not code.

**Files:**
- Modify: `watch/CaptionCore/Sources/CaptionCore/SessionController.swift` (only if step 3 fails; see below)
- Modify: `docs/superpowers/specs/2026-08-15-workout-wake-lock-design.md`

**Interfaces:**
- Consumes: the whole feature, as built in Tasks 1-3.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Install on the watch**

Unlock the watch and keep it on your wrist before installing — a locked watch reports a misleading CoreDevice `12040 "no DDI"` failure that looks like a broken install.

Run:

```bash
cd watch && xcodegen generate && \
xcodebuild -project WatchCaptions.xcodeproj -scheme WatchCaptions \
  -destination 'generic/platform=watchOS' -allowProvisioningUpdates build
```

Then install and launch through Xcode, or via the XcodeBuildMCP device tools.

- [ ] **Step 2: Verify the screen stays lit**

Turn "Keep screen on" on, start a session, set the watch down, and leave it for two minutes without touching it.

Expected: the captions stay at full brightness for the whole two minutes. If the screen dims, the builderless session does not hold the display — see the fallback in step 5.

- [ ] **Step 3: Verify nothing was written to Health**

Stop the session. Open the Fitness app on the watch and the Health app on the phone.

Expected: **no workout in the history, and the Activity rings unmoved.** This is the claim the whole approach depends on. If a workout appears, stop and report it rather than shipping — the spec's Unknowns section says the honest options are to accept it or abandon the approach, and that is the user's call, not the implementer's.

- [ ] **Step 4: Verify audio still works**

Confirm captions arrived normally throughout the session in step 2 — the workout session must not disturb the existing `.record` / `.measurement` audio session.

Expected: captions throughout, no gaps at the start where the workout session began.

- [ ] **Step 5: If the screen dimmed, apply the fallback**

Only if step 2 failed. Add an `HKLiveWorkoutBuilder` to `WorkoutWakeLock.beginSession()` and begin collection, while still never calling `finishWorkout()`:

```swift
            let builder = session.associatedWorkoutBuilder()
            builder.dataSource = HKLiveWorkoutDataSource(healthStore: store, workoutConfiguration: configuration)
            builder.beginCollection(withStart: Date()) { _, _ in }
            self.builder = builder
```

with `private var builder: HKLiveWorkoutBuilder?` added as a stored property, and `builder = nil` added to `release()`. Then repeat steps 2 and 3 — including the Health check, since a collecting builder is more likely to leave a trace.

- [ ] **Step 6: Record the answers in the spec**

Replace the spec's "Unknowns" section with what was actually observed — whether the screen stayed lit, whether anything reached Health, and whether the fallback was needed. An unknown that has been settled should stop reading as an open question.

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/specs/2026-08-15-workout-wake-lock-design.md
git commit -m "docs: record what the on-device wake-lock verification found"
```
