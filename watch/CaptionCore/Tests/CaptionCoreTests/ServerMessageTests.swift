import XCTest
@testable import CaptionCore

final class ServerMessageTests: XCTestCase {
    private func decode(_ json: String) throws -> ServerMessage {
        try ServerMessage.decode(Data(json.utf8))
    }

    func testDecodesReady() throws {
        XCTAssertEqual(try decode(#"{"type":"ready"}"#), .ready)
    }

    func testDecodesPartialCaption() throws {
        XCTAssertEqual(
            try decode(#"{"type":"caption","text":"hello","isFinal":false}"#),
            .caption(text: "hello", isFinal: false, channel: nil)
        )
    }

    func testDecodesFinalCaption() throws {
        XCTAssertEqual(
            try decode(#"{"type":"caption","text":"hello world","isFinal":true}"#),
            .caption(text: "hello world", isFinal: true, channel: nil)
        )
    }

    func testDecodesError() throws {
        XCTAssertEqual(
            try decode(#"{"type":"error","message":"boom"}"#),
            .error(message: "boom")
        )
    }

    func testThrowsOnUnknownType() {
        XCTAssertThrowsError(try decode(#"{"type":"weird"}"#))
    }

    func testDecodesCaptionWithChannel() throws {
        let data = Data(#"{"type":"caption","text":"hi","isFinal":true,"channel":1}"#.utf8)
        XCTAssertEqual(try ServerMessage.decode(data), .caption(text: "hi", isFinal: true, channel: 1))
    }

    func testDecodesCaptionWithoutChannel() throws {
        let data = Data(#"{"type":"caption","text":"hi","isFinal":false}"#.utf8)
        XCTAssertEqual(try ServerMessage.decode(data), .caption(text: "hi", isFinal: false, channel: nil))
    }
}
