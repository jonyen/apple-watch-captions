import XCTest
@testable import CaptionCore

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

    func poll(since: Int) async throws -> CallUpdate {
        polledSince.append(since)
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
}
