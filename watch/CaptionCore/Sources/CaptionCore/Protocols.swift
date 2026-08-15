import Foundation

/// Transport to the caption relay. Callbacks are delivered on the main actor.
public protocol Relay: AnyObject {
    var onMessage: (@MainActor (ServerMessage) -> Void)? { get set }
    var onClose: (@MainActor () -> Void)? { get set }
    /// `mode` decides what the relay does with this session's captions —
    /// whether it persists them, and which transcript it appends to.
    func connect(mode: SessionMode)
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

/// Holds the watch display awake for the length of a session.
///
/// Main-actor isolated because both callers — `SessionController` and
/// `AppModel` — already are, and a `@MainActor` implementation cannot satisfy
/// a nonisolated synchronous requirement.
///
/// `acquire()` is synchronous by design. The only implementation needs async
/// authorization work, but the controller must not gain a suspension point
/// between the permission gate and `connect` — so the implementation owns that
/// Task. Nothing is reported back because failure is silent by design: a lock
/// that cannot be taken lets the screen dim, and captioning continues.
///
/// Invariants an implementation must satisfy: `release()` may be called with
/// no prior `acquire()` — `SessionController.stop()` calls it unconditionally
/// on every session end, whether or not a lock was ever taken — and
/// `acquire()` may be called more than once in a row without an intervening
/// `release()`. Both must be safe no-ops (or idempotent) rather than errors.
///
/// A conforming type must not itself inherit from `NSObject`. Some
/// implementations need an Objective-C delegate conformance underneath them
/// (`HKWorkoutSessionDelegate`, for one), which requires an `NSObject`-based
/// conformer — but `NSObject` carries the legacy Objective-C `release`
/// selector, which collides with `release()` above and makes the type
/// ambiguous to the compiler. Put that delegate conformance on a separate
/// object instead, as `WorkoutWakeLock` does with `WorkoutSessionDelegate`.
@MainActor
public protocol DisplayWakeLocking: AnyObject {
    func acquire()
    func release()
}
