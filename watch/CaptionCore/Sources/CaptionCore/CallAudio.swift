import Foundation

/// One poll's worth of the caller's audio.
public struct AudioChunk: Equatable, Sendable {
    public let samples: [Int16]
    public let seq: Int

    public init(samples: [Int16], seq: Int) {
        self.samples = samples
        self.seq = seq
    }
}

/// Fetches the caller's audio from the relay.
public protocol CallAudioClient: Sendable {
    func fetch(since: Int) async throws -> AudioChunk
}

/// Polls the caller's audio and hands it to a player.
///
/// Owns the cursor and the failure policy, so the player only ever deals in
/// samples. A failed fetch deliberately leaves the cursor where it is: the
/// audio it would have carried is gone either way, and advancing past it would
/// also skip whatever arrived alongside.
@MainActor
public final class CallAudio {
    /// How many polls to collect before playback starts. One second of buffer
    /// against a link that batches roughly every second.
    public static let prerollChunks = 1

    private let client: CallAudioClient
    private let onSamples: ([Int16]) -> Void
    private var seq = 0

    public init(client: CallAudioClient, onSamples: @escaping ([Int16]) -> Void) {
        self.client = client
        self.onSamples = onSamples
    }

    /// Start a new call's audio from the beginning.
    public func reset() {
        seq = 0
    }

    public func poll() async {
        guard let chunk = try? await client.fetch(since: seq) else { return }
        seq = max(seq, chunk.seq)
        guard !chunk.samples.isEmpty else { return }
        onSamples(chunk.samples)
    }
}
