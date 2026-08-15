import Foundation
import HealthKit
import CaptionCore
import os

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
/// That keeps `session` and `startTask` on one actor, so the unstructured
/// Tasks below — which inherit the main actor — need no hopping to touch
/// them.
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
    /// Whether an orphaned-session recovery has already been kicked off.
    /// Recovery only matters once per launch — a session can only be
    /// orphaned by a kill or crash that happened before this instance
    /// existed, not by anything that can happen again while it's alive.
    private var hasAttemptedOrphanRecovery = false
    private let logger = Logger(subsystem: "com.jonyen.watchcaptions.watchkitapp", category: "wakelock")

    func acquire() {
        guard HKHealthStore.isHealthDataAvailable() else {
            logger.error("[wakelock] health data unavailable; screen will dim")
            return
        }
        recoverOrphanedSessionIfNeeded()
        guard session == nil, startTask == nil else { return }
        generation += 1
        let generation = self.generation
        startTask = Task { [weak self] in
            guard let self else { return }
            do {
                try await self.store.requestAuthorization(toShare: [HKObjectType.workoutType()], read: [])
            } catch {
                self.logger.error("[wakelock] authorization failed: \(error); screen will dim")
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

    /// Recovers a workout session left running by a killed or crashed prior
    /// process and ends it, so it stops blocking every future
    /// `HKWorkoutSession` construction (only one may be active at a time) and
    /// stops costing battery and showing an active-workout indicator the user
    /// never asked for.
    ///
    /// Fires once, fire-and-forget: it races the authorization/session-start
    /// work above rather than gating it, so a recovery in flight never delays
    /// the screen staying lit. If it loses that race, this particular
    /// `acquire()` fails the same silent way any other `HKWorkoutSession`
    /// construction failure does, but the orphan is gone by the time the next
    /// `acquire()` tries.
    ///
    /// The recovered session is never adopted as `self.session` — it belongs
    /// to a prior instance's lifecycle, not this one's, and adopting it would
    /// add a state machine this design doesn't need. It is only ever ended.
    /// Because it never touches `session`, `startTask`, or `generation`, this
    /// task needs no generation guard of its own: there is nothing here for a
    /// later `release()` or `acquire()` to race against.
    private func recoverOrphanedSessionIfNeeded() {
        guard !hasAttemptedOrphanRecovery else { return }
        hasAttemptedOrphanRecovery = true
        Task { [store, logger] in
            do {
                if let orphan = try await store.recoverActiveWorkoutSession() {
                    orphan.end()
                }
            } catch {
                logger.error("[wakelock] orphaned session recovery failed: \(error); screen will dim")
            }
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
            logger.error("[wakelock] workout session failed to start: \(error); screen will dim")
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
    private let logger = Logger(subsystem: "com.jonyen.watchcaptions.watchkitapp", category: "wakelock")

    func workoutSession(_ workoutSession: HKWorkoutSession,
                        didChangeTo toState: HKWorkoutSessionState,
                        from fromState: HKWorkoutSessionState,
                        date: Date) {}

    func workoutSession(_ workoutSession: HKWorkoutSession,
                        didFailWithError error: Error) {
        logger.error("[wakelock] workout session failed: \(error); screen will dim")
    }
}
