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
///
/// There is no preroll. Buffering a chunk before starting playback would buy
/// smoothness by adding a second of latency to a path that is already about
/// two seconds behind the caller — the wrong trade for a conversation. The
/// jitter policy that survived is `CallAudioPlayer`'s bounded queue: schedule
/// each batch as it lands and drop anything that would push playback more than
/// ~2s behind, so gaps stay audible rather than turning into drift.
@MainActor
public final class CallAudio {
    private let client: CallAudioClient
    private let onSamples: ([Int16]) -> Void
    private var seq = 0
    /// True while a `fetch` is in flight. `@MainActor` methods are reentrant
    /// across suspension points, so two `poll()` calls started before either
    /// resumes would otherwise both read the same `seq`, both fetch the same
    /// audio window, and both hand it to `onSamples` — audible as a stutter.
    /// A `poll()` that arrives while one is already in flight is a no-op
    /// rather than a second fetch. Mirrors `CallCaptions.generation`, just
    /// with one cursor to protect instead of a whole session to invalidate.
    private var inFlight = false

    public init(client: CallAudioClient, onSamples: @escaping ([Int16]) -> Void) {
        self.client = client
        self.onSamples = onSamples
    }

    /// Start a new call's audio from the beginning.
    public func reset() {
        seq = 0
    }

    public func poll() async {
        guard !inFlight else { return }
        inFlight = true
        defer { inFlight = false }
        guard let chunk = try? await client.fetch(since: seq) else { return }
        seq = max(seq, chunk.seq)
        guard !chunk.samples.isEmpty else { return }
        onSamples(chunk.samples)
    }
}
