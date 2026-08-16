import Foundation

/// A captioning engine: audio in, caption events out. Callbacks on the main actor.
public protocol CaptionEngine: AnyObject {
    var onEvent: (@MainActor (CaptionEvent) -> Void)? { get set }
    var onClose: (@MainActor () -> Void)? { get set }
    func start()
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
