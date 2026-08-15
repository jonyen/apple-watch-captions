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
///
/// Does not itself inherit from `NSObject`. `HKWorkoutSessionDelegate` is an
/// Objective-C protocol and requires an `NSObject`-based conformer, but
/// `NSObject` also carries the legacy Objective-C `release` selector — which
/// collides with `DisplayWakeLocking.release()` and makes the type ambiguous
/// to the compiler. `WorkoutSessionDelegate` below takes the `NSObject`
/// conformance instead, keeping that collision out of this type entirely.
@MainActor
final class WorkoutWakeLock: DisplayWakeLocking {
    private let store = HKHealthStore()
    private var session: HKWorkoutSession?
    /// Retained so a release arriving before authorization finishes can cancel it.
    private var startTask: Task<Void, Never>?
    private let delegate = WorkoutSessionDelegate()
    /// Identifies the current acquire/release cycle. `startTask?.cancel()` in
    /// `release()` is only a best-effort request — HealthKit does not observe
    /// Swift task cancellation, so `requestAuthorization` can still resume
    /// long after the task that awaits it was cancelled, possibly after a
    /// later `acquire()` has already started a new attempt. `Task.isCancelled`
    /// alone can't tell that stale resumption apart from a current one, so
    /// every write the task makes to `startTask`/`session` is guarded by
    /// comparing against this instead. Bumped by `acquire()` (once it clears
    /// the re-entrancy guard) and by `release()`, mirroring
    /// `SessionController.generation`.
    private var generation = 0

    func acquire() {
        guard HKHealthStore.isHealthDataAvailable() else {
            print("[wakelock] health data unavailable; screen will dim")
            return
        }
        guard session == nil, startTask == nil else { return }
        generation += 1
        let generation = self.generation
        startTask = Task { [weak self] in
            guard let self else { return }
            do {
                try await self.store.requestAuthorization(toShare: [HKObjectType.workoutType()], read: [])
            } catch {
                print("[wakelock] authorization failed: \(error); screen will dim")
                if self.generation == generation { self.startTask = nil }
                return
            }
            // A generation mismatch here means release() (or a superseding
            // acquire()) already moved on without us; don't touch startTask
            // or session, and don't start a session this instance no longer
            // wants running.
            guard self.generation == generation else { return }
            self.startTask = nil
            self.beginSession()
        }
    }

    func release() {
        generation += 1
        startTask?.cancel()
        startTask = nil
        session?.end()
        session = nil
    }

    private func beginSession() {
        let configuration = HKWorkoutConfiguration()
        configuration.activityType = .other
        configuration.locationType = .indoor
        do {
            let session = try HKWorkoutSession(healthStore: store, configuration: configuration)
            session.delegate = delegate
            session.startActivity(with: Date())
            self.session = session
        } catch {
            print("[wakelock] workout session failed to start: \(error); screen will dim")
        }
    }
}

/// The delegate is required for the session to run. Nothing here needs to react
/// to a state change — the session exists only for its side effect on the
/// display — so these are deliberately near-empty. A standalone type (rather
/// than an extension on `WorkoutWakeLock`) because `HKWorkoutSessionDelegate`
/// requires `NSObject`, and `NSObject` carries an Objective-C `release`
/// selector that collides with `DisplayWakeLocking.release()` on the same type.
private final class WorkoutSessionDelegate: NSObject, HKWorkoutSessionDelegate {
    nonisolated func workoutSession(_ workoutSession: HKWorkoutSession,
                                    didChangeTo toState: HKWorkoutSessionState,
                                    from fromState: HKWorkoutSessionState,
                                    date: Date) {}

    nonisolated func workoutSession(_ workoutSession: HKWorkoutSession,
                                    didFailWithError error: Error) {
        print("[wakelock] workout session failed: \(error); screen will dim")
    }
}
