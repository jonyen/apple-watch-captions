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
    private func make(_ client: FakeAudioClient) -> (CallAudio, () -> [[Int16]]) {
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
}
