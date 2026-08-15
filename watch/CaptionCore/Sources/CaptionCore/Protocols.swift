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
@MainActor
public protocol DisplayWakeLocking: AnyObject {
    func acquire()
    func release()
}
