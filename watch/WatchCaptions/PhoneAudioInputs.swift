import Foundation
import CaptionCore

/// Capture that captures nothing.
///
/// Reading the phone's audio runs the same `SessionController` a mic session
/// does — permission, connect, wait for `ready`, stream — with the streaming
/// half removed. The Watch is a reader here; the audio is already being posted
/// by the phone. Giving the controller a capture that produces no chunks is
/// less machinery than a second controller that knows how to do everything
/// except listen.
final class SilentCapture: AudioCapturing {
    func start(onChunk: @escaping (Data) -> Void) throws {}
    func stop() {}
}

/// No microphone is opened, so there is nothing to ask for. Returning true
/// keeps the controller's permission gate from blocking a session that never
/// touches the mic — and, more to the point, from prompting for access the
/// user has no reason to grant.
struct NoMicNeeded: MicPermissionProviding {
    func ensureGranted() async -> Bool { true }
}
