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
