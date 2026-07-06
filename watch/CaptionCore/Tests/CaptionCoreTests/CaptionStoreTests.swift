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
        s.apply(.caption(text: "hel", isFinal: false, channel: nil))
        XCTAssertEqual(s.partial, "hel")
        XCTAssertTrue(s.lines.isEmpty)
    }

    func testFinalAppendsAndClearsPartial() {
        let s = CaptionStore()
        s.apply(.caption(text: "hel", isFinal: false, channel: nil))
        s.apply(.caption(text: "hello", isFinal: true, channel: nil))
        XCTAssertEqual(s.lines, [CaptionLine(text: "hello", channel: nil)])
        XCTAssertEqual(s.partial, "")
    }

    func testEmptyFinalIsNotAppended() {
        let s = CaptionStore()
        s.apply(.caption(text: "", isFinal: true, channel: nil))
        XCTAssertTrue(s.lines.isEmpty)
    }

    func testErrorSetsErrorState() {
        let s = CaptionStore()
        s.apply(.error(message: "boom"))
        XCTAssertEqual(s.state, .error("boom"))
    }

    func testResetClearsEverything() {
        let s = CaptionStore()
        s.apply(.caption(text: "hi", isFinal: true, channel: nil))
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

    @MainActor func testTracksChannelsOnLinesAndPartials() {
        let store = CaptionStore()
        store.apply(.caption(text: "typing…", isFinal: false, channel: 1))
        XCTAssertEqual(store.partials[1], "typing…")
        store.apply(.caption(text: "done", isFinal: true, channel: 1))
        XCTAssertEqual(store.lines.last, CaptionLine(text: "done", channel: 1))
        XCTAssertEqual(store.partials[1], "")
    }
}
