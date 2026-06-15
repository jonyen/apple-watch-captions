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
