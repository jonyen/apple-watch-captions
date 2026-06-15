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
            .caption(text: "hello", isFinal: false)
        )
    }

    func testDecodesFinalCaption() throws {
        XCTAssertEqual(
            try decode(#"{"type":"caption","text":"hello world","isFinal":true}"#),
            .caption(text: "hello world", isFinal: true)
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
}
