import XCTest
@testable import CaptionCore

private final class FakeVoiceClient: CallVoiceClient, @unchecked Sendable {
    private(set) var sent: [Data] = []
    var error: Error?

    func send(_ pcm: Data) async throws {
        if let error { throw error }
        sent.append(pcm)
    }
}

@MainActor
final class CallVoiceTests: XCTestCase {
    /// Audio captured while not talking is the room, not you. Sending it would
    /// put whatever is around you onto the call.
    func testDiscardsAudioCapturedWhileNotTalking() async {
        let client = FakeVoiceClient()
        let voice = CallVoice(client: client)

        voice.capture(Data([1, 2]))
        await voice.endTalking()

        XCTAssertEqual(client.sent.count, 0)
    }

    func testSendsWhatWasCapturedWhileTalking() async {
        let client = FakeVoiceClient()
        let voice = CallVoice(client: client)

        voice.beginTalking()
        voice.capture(Data([1, 2]))
        voice.capture(Data([3, 4]))
        await voice.endTalking()

        XCTAssertEqual(client.sent, [Data([1, 2, 3, 4])])
    }

    func testReportsWhetherYouAreTalking() async {
        let voice = CallVoice(client: FakeVoiceClient())

        XCTAssertFalse(voice.isTalking)
        voice.beginTalking()
        XCTAssertTrue(voice.isTalking)
        await voice.endTalking()
        XCTAssertFalse(voice.isTalking)
    }

    /// A failed send must still release the button, or the UI shows you as
    /// talking forever.
    func testStopsTalkingEvenWhenTheSendFails() async {
        let client = FakeVoiceClient()
        client.error = HistoryError.message("offline")
        let voice = CallVoice(client: client)

        voice.beginTalking()
        voice.capture(Data([1]))
        await voice.endTalking()

        XCTAssertFalse(voice.isTalking)
    }

    func testASecondTurnDoesNotResendTheFirst() async {
        let client = FakeVoiceClient()
        let voice = CallVoice(client: client)
        voice.beginTalking()
        voice.capture(Data([1]))
        await voice.endTalking()

        voice.beginTalking()
        voice.capture(Data([2]))
        await voice.endTalking()

        XCTAssertEqual(client.sent, [Data([1]), Data([2])])
    }

    /// `DragGesture.onChanged` fires repeatedly for one held press, so
    /// `beginTalking()` is called many times per turn. A repeat call must not
    /// reset the buffer, or audio already captured mid-word is dropped with
    /// no signal to the user.
    func testARepeatBeginTalkingDoesNotWipeTheBuffer() async {
        let client = FakeVoiceClient()
        let voice = CallVoice(client: client)

        voice.beginTalking()
        voice.capture(Data([1]))
        voice.beginTalking()
        voice.capture(Data([2]))
        voice.beginTalking()
        await voice.endTalking()

        XCTAssertEqual(client.sent, [Data([1, 2])])
    }

    /// A `CallVoiceClient` whose `send` blocks until a test releases it, so a
    /// turn left in flight by one `endTalking()` can be overlapped by a
    /// second, deterministically, instead of racing on real concurrency.
    /// Mirrors `CallAudioTests.GatedAudioClient` / `CallCaptionsTests.GatedCallClient`.
    private actor GatedVoiceClient: CallVoiceClient {
        private var registeredCalls = 0
        private var waiters: [CheckedContinuation<Void, Error>] = []
        private var arrivalWatchers: [(need: Int, continuation: CheckedContinuation<Void, Never>)] = []
        private(set) var received: [Data] = []

        func send(_ pcm: Data) async throws {
            received.append(pcm)
            try await withCheckedThrowingContinuation { continuation in
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

        /// Resolves the oldest still-waiting call.
        func resumeOldest() {
            guard !waiters.isEmpty else { return }
            waiters.removeFirst().resume(returning: ())
        }

        private func notifyArrivals() {
            arrivalWatchers.removeAll { watcher in
                guard registeredCalls >= watcher.need else { return false }
                watcher.continuation.resume()
                return true
            }
        }
    }

    /// A second `beginTalking()`/`capture()`/`endTalking()` that lands while
    /// the first turn's `send` is still in flight must not lose, duplicate,
    /// or blend the two turns, and must not leave `isTalking` stuck. This is
    /// the reentrancy the four other `CaptionCore` state-corruption bugs had:
    /// state read before an `await` and written back after it. `endTalking()`
    /// avoids that shape by resetting `turn`/`isTalking` before its one
    /// `await`; this is the regression test for that ordering.
    func testAnOverlappingTurnDoesNotCorruptTheOneBeingSent() async {
        let client = GatedVoiceClient()
        let voice = CallVoice(client: client)

        voice.beginTalking()
        voice.capture(Data([1]))
        async let first: CallVoiceError? = voice.endTalking()
        await client.waitForArrival(1)

        // Starts and finishes while `first`'s send is still suspended. If
        // `turn`/`isTalking` were reset after the `await` instead of before,
        // this `beginTalking()` would still see `isTalking == true` and no-op
        // (thanks to the idempotency guard above), so this `capture` would
        // land in turn 1's buffer instead of starting turn 2.
        voice.beginTalking()
        voice.capture(Data([2]))
        async let second: CallVoiceError? = voice.endTalking()
        await client.waitForArrival(2)

        await client.resumeOldest()
        _ = await first
        await client.resumeOldest()
        _ = await second

        let received = await client.received
        XCTAssertEqual(received, [Data([1]), Data([2])])
        XCTAssertFalse(voice.isTalking)
    }

    /// The relay refuses a turn with 409 when no call is live. That is not a
    /// dropped packet — every further turn will be refused the same way — so
    /// it has to reach the user instead of leaving them pressing and
    /// speaking into a call that ended.
    func testReportsTheRelaysRefusalWhenNoCallIsLive() async {
        let client = FakeVoiceClient()
        client.error = CallVoiceError.noCallLive
        let voice = CallVoice(client: client)

        voice.beginTalking()
        voice.capture(Data([1]))
        let failure = await voice.endTalking()

        XCTAssertEqual(failure, .noCallLive)
    }

    /// One lost turn on a live call is a "say that again", not an error
    /// screen over a conversation still in progress.
    func testSwallowsATransientSendFailure() async {
        let client = FakeVoiceClient()
        client.error = HistoryError.message("offline")
        let voice = CallVoice(client: client)

        voice.beginTalking()
        voice.capture(Data([1]))

        let failure = await voice.endTalking()
        XCTAssertNil(failure)
    }

    func testASuccessfulTurnReportsNoFailure() async {
        let voice = CallVoice(client: FakeVoiceClient())

        voice.beginTalking()
        voice.capture(Data([1]))

        let failure = await voice.endTalking()
        XCTAssertNil(failure)
    }
}
