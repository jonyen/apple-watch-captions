import CaptionCore
import XCTest
@testable import CaptionRelay

final class CallUpdateDecodingTests: XCTestCase {
    func testDecodesALiveCallWithCaptions() {
        let update = decodeCallUpdate([
            "active": true,
            "seq": 4,
            "events": [
                ["seq": 3, "type": "caption", "text": "hello", "isFinal": false],
                ["seq": 4, "type": "caption", "text": "hello there", "isFinal": true],
            ],
        ])

        XCTAssertTrue(update.active)
        XCTAssertEqual(update.seq, 4)
        XCTAssertEqual(update.events, [
            .caption(text: "hello", isFinal: false, channel: nil),
            .caption(text: "hello there", isFinal: true, channel: nil),
        ])
        XCTAssertNil(update.reason)
    }

    func testDecodesACallThatEnded() {
        let update = decodeCallUpdate(["active": false, "reason": "ended", "seq": 9])

        XCTAssertFalse(update.active)
        XCTAssertEqual(update.reason, .ended)
    }

    /// A stream that died under a live call is a different thing to say than
    /// "the call ended", so the wire value has to survive decoding.
    func testDecodesALostStream() {
        XCTAssertEqual(
            decodeCallUpdate(["active": false, "reason": "stream_lost"]).reason, .streamLost)
    }

    func testDecodesRelayErrors() {
        let update = decodeCallUpdate([
            "active": true,
            "events": [["type": "error", "message": "transcription connection lost"]],
        ])

        XCTAssertEqual(update.events, [.error(message: "transcription connection lost")])
    }

    /// An unexpected body must not read as a live call.
    func testAnEmptyBodyReadsAsNoCall() {
        let update = decodeCallUpdate([:])

        XCTAssertFalse(update.active)
        XCTAssertEqual(update.events, [])
        XCTAssertEqual(update.seq, 0)
    }

    /// Whether the watch holds the call decides whether it plays the caller
    /// aloud and offers push-to-talk at all.
    func testDecodesACallTheWatchHolds() {
        XCTAssertTrue(decodeCallUpdate(["active": true, "twoWay": true]).twoWay)
    }

    /// Absent reads as captions-only, the safe direction: guessing wrong the
    /// other way plays the caller aloud into a room where the user is already
    /// holding that call on their phone.
    func testACallWithoutTheFlagReadsAsCaptionsOnly() {
        XCTAssertFalse(decodeCallUpdate(["active": true]).twoWay)
        XCTAssertFalse(decodeCallUpdate(["active": true, "twoWay": false]).twoWay)
    }

    func testSkipsEventTypesItDoesNotKnow() {
        let update = decodeCallUpdate([
            "active": true,
            "events": [["type": "wat"], ["type": "caption", "text": "hi", "isFinal": true]],
        ])

        XCTAssertEqual(update.events, [.caption(text: "hi", isFinal: true, channel: nil)])
    }
}

private final class FakeCallClient: CallClient, @unchecked Sendable {
    var updates: [CallUpdate] = []
    var error: Error?
    private(set) var polledSince: [Int] = []
    private(set) var polledReady: [Bool] = []

    func poll(since: Int, ready: Bool) async throws -> CallUpdate {
        polledSince.append(since)
        polledReady.append(ready)
        if let error { throw error }
        return updates.isEmpty
            ? CallUpdate(active: true, reason: nil, events: [], seq: since)
            : updates.removeFirst()
    }
}

@MainActor
final class CallCaptionsTests: XCTestCase {
    private func make(_ client: FakeCallClient) -> (CallCaptions, CaptionStore) {
        let store = CaptionStore()
        return (CallCaptions(client: client, store: store), store)
    }

    func testCaptionsReachTheStore() async {
        let client = FakeCallClient()
        client.updates = [CallUpdate(
            active: true, reason: nil,
            events: [.ready, .caption(text: "hello there", isFinal: true, channel: nil)],
            seq: 2)]
        let (captions, store) = make(client)

        let keepGoing = await captions.poll()

        XCTAssertTrue(keepGoing)
        XCTAssertEqual(store.paragraphs.map(\.text), ["hello there"])
        XCTAssertEqual(store.state, .listening)
    }

    func testAdvancesTheCursorSoCaptionsArriveOnce() async {
        let client = FakeCallClient()
        client.updates = [CallUpdate(active: true, reason: nil, events: [], seq: 7)]
        let (captions, _) = make(client)

        _ = await captions.poll()
        _ = await captions.poll()

        XCTAssertEqual(client.polledSince, [0, 7])
    }

    func testEndsWhenTheCallEnds() async {
        let client = FakeCallClient()
        client.updates = [
            CallUpdate(active: true, reason: nil, events: [], seq: 1),
            CallUpdate(active: false, reason: .ended, events: [], seq: 1),
        ]
        let (captions, _) = make(client)

        _ = await captions.poll()
        let keepGoing = await captions.poll()

        XCTAssertFalse(keepGoing)
        XCTAssertEqual(captions.ended, .ended)
    }

    /// Captions dying under a live call is a different thing to show than the
    /// call ending, so the reason has to survive to the screen.
    func testALostStreamIsReportedAsItsOwnThing() async {
        let client = FakeCallClient()
        client.updates = [
            CallUpdate(active: true, reason: nil, events: [], seq: 1),
            CallUpdate(active: false, reason: .streamLost, events: [], seq: 1),
        ]
        let (captions, _) = make(client)

        _ = await captions.poll()
        _ = await captions.poll()

        XCTAssertEqual(captions.ended, .streamLost)
    }

    /// A watch out of range is not the call ending.
    func testATransientFailureKeepsPolling() async {
        let client = FakeCallClient()
        client.error = HistoryError.message("offline")
        let (captions, _) = make(client)

        let keepGoing = await captions.poll()

        XCTAssertTrue(keepGoing)
        XCTAssertNil(captions.ended)
    }

    /// Entering call mode races the relay noticing the call. An inactive first
    /// answer must not end a call that has not started.
    func testAnInactiveFirstAnswerDoesNotEndTheCall() async {
        let client = FakeCallClient()
        client.updates = [CallUpdate(active: false, reason: nil, events: [], seq: 0)]
        let (captions, _) = make(client)

        let keepGoing = await captions.poll()

        XCTAssertTrue(keepGoing)
        XCTAssertNil(captions.ended)
    }

    /// A `CallClient` whose `poll(since:ready:)` calls block until a test releases
    /// them, so a poll left in flight by one loop can be superseded by a
    /// `start()`/`stop()` deterministically instead of racing on real
    /// concurrency or timers. Mirrors `SessionControllerTests.GatedHistory`.
    private actor GatedCallClient: CallClient {
        private var registeredCalls = 0
        private var waiters: [CheckedContinuation<CallUpdate, Error>] = []
        private var arrivalWatchers: [(need: Int, continuation: CheckedContinuation<Void, Never>)] = []
        private(set) var polledSince: [Int] = []

        func poll(since: Int, ready: Bool) async throws -> CallUpdate {
            polledSince.append(since)
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

        /// Resolves the oldest still-waiting call.
        func resumeOldest(with update: CallUpdate) {
            guard !waiters.isEmpty else { return }
            waiters.removeFirst().resume(returning: update)
        }

        private func notifyArrivals() {
            arrivalWatchers.removeAll { watcher in
                guard registeredCalls >= watcher.need else { return false }
                watcher.continuation.resume()
                return true
            }
        }
    }

    private func make(_ client: GatedCallClient) -> (CallCaptions, CaptionStore) {
        let store = CaptionStore()
        return (CallCaptions(client: client, store: store), store)
    }

    /// A poll already in flight when `stop()` runs must not lead to another
    /// request once it resolves — that would mean the loop kept going after
    /// being told to stop.
    func testStopHaltsPolling() async {
        let client = GatedCallClient()
        let (captions, _) = make(client)

        captions.start()
        await client.waitForArrival(1)

        captions.stop()
        await client.resumeOldest(with: CallUpdate(active: true, reason: nil, events: [], seq: 1))
        await captions.waitForSupersededLoop()

        let requests = await client.polledSince
        XCTAssertEqual(requests, [0])
    }

    /// `start()` replaces the loop rather than adding a second one alongside
    /// it: the superseded loop's in-flight poll must not lead to a further
    /// request of its own once it resolves.
    func testStartingAgainSupersedesThePreviousLoopRatherThanAddingASecondOne() async {
        let client = GatedCallClient()
        let (captions, _) = make(client)

        captions.start()
        await client.waitForArrival(1)

        captions.start()
        await client.waitForArrival(2)

        await client.resumeOldest(with: CallUpdate(active: true, reason: nil, events: [], seq: 1))
        await captions.waitForSupersededLoop()

        // Only the two initial requests — one per generation — should have
        // happened; the superseded loop did not go on to request a second poll.
        let requests = await client.polledSince
        XCTAssertEqual(requests, [0, 0])

        // Resolve the still-open current-generation request and tear down so
        // nothing is left dangling.
        await client.resumeOldest(with: CallUpdate(active: true, reason: nil, events: [], seq: 2))
        captions.stop()
        await captions.waitForSupersededLoop()
    }

    /// The regression this task fixes: a poll already in flight when `start()`
    /// resets state must not write its answer into the new session once it
    /// resolves — not a stale caption landing in the just-cleared store, and
    /// not a stale `seq` skipping the new session's own early captions.
    func testAStaleInFlightPollDoesNotCorruptANewSession() async {
        let client = GatedCallClient()
        let (captions, store) = make(client)

        captions.start()
        await client.waitForArrival(1)   // first loop's poll (generation 1) in flight

        captions.start()                 // supersedes it before it resolves
        await client.waitForArrival(2)   // second loop's poll (generation 2) in flight

        // Resolve the stale (first) poll with data that must not land.
        await client.resumeOldest(with: CallUpdate(
            active: true, reason: nil,
            events: [.caption(text: "stale", isFinal: true, channel: nil)],
            seq: 99))
        await captions.waitForSupersededLoop()

        XCTAssertEqual(store.paragraphs.map(\.text), [])

        // The current generation's own request must still be asking from 0 —
        // proof the stale answer's seq: 99 never reached it.
        let requests = await client.polledSince
        XCTAssertEqual(requests, [0, 0])

        // Resolve the still-open current-generation request and tear down.
        await client.resumeOldest(with: CallUpdate(active: true, reason: nil, events: [], seq: 2))
        captions.stop()
        await captions.waitForSupersededLoop()
    }

    /// Entering call mode is a wait: the screen opens before any call exists,
    /// and this is what says one has arrived — the moment audio may start and
    /// the talk gesture becomes real.
    func testAnnouncesTheCallArriving() async {
        let client = FakeCallClient()
        client.updates = [
            CallUpdate(active: false, reason: nil, events: [], seq: 0),
            CallUpdate(active: true, reason: nil, events: [], seq: 1, twoWay: true),
        ]
        let (captions, _) = make(client)
        var arrivals: [Bool] = []
        captions.onLive = { arrivals.append($0) }

        _ = await captions.poll()
        XCTAssertEqual(arrivals, [], "no call yet: still waiting")

        _ = await captions.poll()
        XCTAssertEqual(arrivals, [true])
    }

    /// A captions-only fallback arrives through the same path and differs
    /// only in what the watch may do with it.
    func testAnnouncesAFallbackCallAsCaptionsOnly() async {
        let client = FakeCallClient()
        client.updates = [CallUpdate(active: true, reason: nil, events: [], seq: 1, twoWay: false)]
        let (captions, _) = make(client)
        var arrivals: [Bool] = []
        captions.onLive = { arrivals.append($0) }

        _ = await captions.poll()

        XCTAssertEqual(arrivals, [false])
    }

    /// Once per call, not once per poll: this starts the audio engine and
    /// moves the screen off the waiting state.
    func testAnnouncesTheCallOnlyOnce() async {
        let client = FakeCallClient()
        let (captions, _) = make(client)
        var arrivals = 0
        captions.onLive = { _ in arrivals += 1 }

        _ = await captions.poll()
        _ = await captions.poll()
        _ = await captions.poll()

        XCTAssertEqual(arrivals, 1)
    }

    /// Presence is what decides whether an inbound call is handed to the
    /// watch at all, and this loop runs only while the call screen is up —
    /// so every poll it makes claims it.
    func testPollingTheCallScreenClaimsPresence() async {
        let client = FakeCallClient()
        let (captions, _) = make(client)

        _ = await captions.poll()
        _ = await captions.poll()

        XCTAssertEqual(client.polledReady, [true, true])
    }
}
