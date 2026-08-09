import XCTest
@testable import CaptionCore

private final class FakeAudioClient: CallAudioClient, @unchecked Sendable {
    var chunks: [AudioChunk] = []
    var error: Error?
    private(set) var asked: [Int] = []

    func fetch(since: Int) async throws -> AudioChunk {
        asked.append(since)
        if let error { throw error }
        return chunks.isEmpty ? AudioChunk(samples: [], seq: since) : chunks.removeFirst()
    }
}

@MainActor
final class CallAudioTests: XCTestCase {
    private func make(_ client: CallAudioClient) -> (CallAudio, () -> [[Int16]]) {
        var played: [[Int16]] = []
        let audio = CallAudio(client: client) { played.append($0) }
        return (audio, { played })
    }

    func testHandsDecodedSamplesToThePlayer() async {
        let client = FakeAudioClient()
        client.chunks = [AudioChunk(samples: [1, 2, 3], seq: 4)]
        let (audio, played) = make(client)

        await audio.poll()

        XCTAssertEqual(played(), [[1, 2, 3]])
    }

    func testAdvancesTheCursorSoAudioArrivesOnce() async {
        let client = FakeAudioClient()
        client.chunks = [AudioChunk(samples: [1], seq: 7)]
        let (audio, _) = make(client)

        await audio.poll()
        await audio.poll()

        XCTAssertEqual(client.asked, [0, 7])
    }

    /// A dropped poll is a gap in playback, not the end of the call.
    func testAFailedFetchDoesNotAdvanceTheCursor() async {
        let client = FakeAudioClient()
        client.error = HistoryError.message("offline")
        let (audio, played) = make(client)

        await audio.poll()
        await audio.poll()

        XCTAssertEqual(client.asked, [0, 0])
        XCTAssertEqual(played().count, 0)
    }

    func testAnEmptyChunkPlaysNothing() async {
        let client = FakeAudioClient()
        client.chunks = [AudioChunk(samples: [], seq: 3)]
        let (audio, played) = make(client)

        await audio.poll()

        XCTAssertEqual(played().count, 0)
    }

    /// A new call must not resume from the previous call's cursor, or its
    /// first seconds are skipped as already-heard.
    func testResetReturnsTheCursorToTheStart() async {
        let client = FakeAudioClient()
        client.chunks = [AudioChunk(samples: [1], seq: 9)]
        let (audio, _) = make(client)
        await audio.poll()

        audio.reset()
        await audio.poll()

        XCTAssertEqual(client.asked, [0, 0])
    }

    /// `max` rather than plain assignment: if the relay ever answered with a
    /// `seq` behind where the cursor already is, assigning it back would make
    /// the next poll re-request — and replay — audio already handed off.
    func testALowerSeqInTheResponseDoesNotRegressTheCursor() async {
        let client = FakeAudioClient()
        client.chunks = [
            AudioChunk(samples: [1], seq: 10),
            AudioChunk(samples: [2], seq: 3),
        ]
        let (audio, _) = make(client)

        await audio.poll()
        await audio.poll()
        await audio.poll()

        XCTAssertEqual(client.asked, [0, 10, 10])
    }

    /// A `CallAudioClient` whose `fetch(since:)` calls block until a test
    /// releases them, so a `poll()` left in flight by one call can be
    /// overlapped by a second, deterministically, instead of racing on real
    /// concurrency. Mirrors `CallCaptionsTests.GatedCallClient`.
    private actor GatedAudioClient: CallAudioClient {
        private var registeredCalls = 0
        private var waiters: [CheckedContinuation<AudioChunk, Error>] = []
        private var arrivalWatchers: [(need: Int, continuation: CheckedContinuation<Void, Never>)] = []
        private(set) var asked: [Int] = []

        func fetch(since: Int) async throws -> AudioChunk {
            asked.append(since)
            return try await withCheckedThrowingContinuation { continuation in
                waiters.append(continuation)
                registeredCalls += 1
                notifyArrivals()
            }
        }

        /// Waits until `count` calls have arrived, without releasing them.
        func waitForArrival(_ count: Int) async {
            if registeredCalls < count {
                await withCheckedContinuation { arrivalWatchers.append((count, $0)) }
            }
        }

        /// Resolves the oldest still-waiting call, if there is one.
        func resumeOldest(with chunk: AudioChunk) {
            guard !waiters.isEmpty else { return }
            waiters.removeFirst().resume(returning: chunk)
        }

        private func notifyArrivals() {
            arrivalWatchers.removeAll { watcher in
                guard registeredCalls >= watcher.need else { return false }
                watcher.continuation.resume()
                return true
            }
        }
    }

    /// Two `poll()` calls started before either resumes must not both reach
    /// the relay: that would hand the same audio window to `onSamples` twice,
    /// audible as a stutter or an echo of the caller. Regression test for the
    /// in-flight guard.
    func testAnOverlappingPollIsANoOpRatherThanASecondFetch() async {
        let client = GatedAudioClient()
        let (audio, played) = make(client)

        async let first: Void = audio.poll()
        await client.waitForArrival(1)

        // Started while `first` is still in flight. If the guard is missing,
        // this reaches the relay too; if it works, it returns without ever
        // calling `fetch`.
        async let second: Void = audio.poll()
        await second

        await client.resumeOldest(with: AudioChunk(samples: [1, 2, 3], seq: 5))
        await first

        let requests = await client.asked
        XCTAssertEqual(requests, [0])
        XCTAssertEqual(played(), [[1, 2, 3]])
    }
}
