import XCTest
@testable import CaptionCore

@MainActor
final class CaptionStoreTests: XCTestCase {
    func testStartsConnecting() {
        XCTAssertEqual(CaptionStore().state, .connecting)
    }

    func testReadyMovesToListening() {
        let s = CaptionStore()
        s.apply(.ready)
        XCTAssertEqual(s.state, .listening)
    }

    func testPartialSetsPartialLine() {
        let s = CaptionStore()
        s.apply(.caption(text: "hel", isFinal: false))
        XCTAssertEqual(s.partial, "hel")
        XCTAssertTrue(s.lines.isEmpty)
    }

    func testFinalAppendsAndClearsPartial() {
        let s = CaptionStore()
        s.apply(.caption(text: "hel", isFinal: false))
        s.apply(.caption(text: "hello", isFinal: true))
        XCTAssertEqual(s.lines, ["hello"])
        XCTAssertEqual(s.partial, "")
    }

    func testEmptyFinalIsNotAppended() {
        let s = CaptionStore()
        s.apply(.caption(text: "", isFinal: true))
        XCTAssertTrue(s.lines.isEmpty)
    }

    func testErrorSetsErrorState() {
        let s = CaptionStore()
        s.apply(.error(message: "boom"))
        XCTAssertEqual(s.state, .error("boom"))
    }

    func testResetClearsEverything() {
        let s = CaptionStore()
        s.apply(.caption(text: "hi", isFinal: true))
        s.apply(.ready)
        s.reset()
        XCTAssertTrue(s.lines.isEmpty)
        XCTAssertEqual(s.partial, "")
        XCTAssertEqual(s.state, .connecting)
    }

    func testSetErrorSetsErrorState() {
        let s = CaptionStore()
        s.setError("Connection lost")
        XCTAssertEqual(s.state, .error("Connection lost"))
    }
}
