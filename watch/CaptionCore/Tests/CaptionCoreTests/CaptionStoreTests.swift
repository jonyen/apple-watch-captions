import XCTest
@testable import CaptionCore

/// A clock the test advances by hand, so pause detection is deterministic.
private final class TestClock {
    var now = Date(timeIntervalSince1970: 1_000)
    func advance(_ seconds: TimeInterval) { now += seconds }
}

@MainActor
final class CaptionStoreTests: XCTestCase {
    private func store(_ clock: TestClock) -> CaptionStore {
        CaptionStore(now: { clock.now })
    }

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
        XCTAssertTrue(s.paragraphs.isEmpty)
    }

    func testFinalAppendsAndClearsPartial() {
        let s = CaptionStore()
        s.apply(.caption(text: "hel", isFinal: false, channel: nil))
        s.apply(.caption(text: "hello", isFinal: true, channel: nil))
        XCTAssertEqual(s.paragraphs.map(\.text), ["hello"])
        XCTAssertEqual(s.partial, "")
    }

    func testEmptyFinalIsNotAppended() {
        let s = CaptionStore()
        s.apply(.caption(text: "", isFinal: true, channel: nil))
        XCTAssertTrue(s.paragraphs.isEmpty)
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
        XCTAssertTrue(s.paragraphs.isEmpty)
        XCTAssertEqual(s.partial, "")
        XCTAssertEqual(s.state, .connecting)
    }

    func testSetErrorSetsErrorState() {
        let s = CaptionStore()
        s.setError("Connection lost")
        XCTAssertEqual(s.state, .error("Connection lost"))
    }

    @MainActor func testTracksChannelsOnParagraphsAndPartials() {
        let store = CaptionStore()
        store.apply(.caption(text: "typing…", isFinal: false, channel: 1))
        XCTAssertEqual(store.partials[1], "typing…")
        store.apply(.caption(text: "done", isFinal: true, channel: 1))
        XCTAssertEqual(store.paragraphs.last?.text, "done")
        XCTAssertEqual(store.paragraphs.last?.channel, 1)
        XCTAssertEqual(store.partials[1], "")
    }

    func testConsecutiveFinalsJoinIntoOneParagraph() {
        let clock = TestClock()
        let s = store(clock)
        s.apply(.caption(text: "i went to the store", isFinal: true, channel: nil))
        clock.advance(1)
        s.apply(.caption(text: "and it was closed", isFinal: true, channel: nil))

        XCTAssertEqual(s.paragraphs.map(\.text), ["i went to the store and it was closed"])
    }

    /// SwiftUI list diffing depends on `CaptionParagraph.id` staying put across an
    /// in-place append, or the row would flicker/reset as if it were a new paragraph.
    func testJoiningAFinalKeepsTheParagraphIdentity() {
        let clock = TestClock()
        let s = store(clock)
        s.apply(.caption(text: "i went to the store", isFinal: true, channel: nil))
        let idBefore = s.paragraphs[0].id
        clock.advance(1)
        s.apply(.caption(text: "and it was closed", isFinal: true, channel: nil))

        XCTAssertEqual(s.paragraphs[0].id, idBefore)
    }

    func testAFinalAfterSilenceStartsANewParagraph() {
        let clock = TestClock()
        let s = store(clock)
        s.apply(.caption(text: "so that happened", isFinal: true, channel: nil))
        clock.advance(livePauseThreshold)
        s.apply(.caption(text: "anyway", isFinal: true, channel: nil))

        XCTAssertEqual(s.paragraphs.map(\.text), ["so that happened", "anyway"])
    }

    /// The gap is observed by the partial that reopens speech, not by the final
    /// that closes the new utterance — by then the partials have refreshed the
    /// arrival time. So the break has to be remembered when it is seen.
    func testAPartialObservingTheGapStillBreaksTheFinalAfterIt() {
        let clock = TestClock()
        let s = store(clock)
        s.apply(.caption(text: "so that happened", isFinal: true, channel: nil))
        clock.advance(5)
        s.apply(.caption(text: "any", isFinal: false, channel: nil))
        clock.advance(1)
        s.apply(.caption(text: "anyway where were we", isFinal: true, channel: nil))

        XCTAssertEqual(s.paragraphs.map(\.text), ["so that happened", "anyway where were we"])
    }

    /// A long sentence arrives as several finals with partials streaming
    /// throughout. None of it is a pause.
    func testSteadySpeechKeepsOneParagraphAcrossManyFinals() {
        let clock = TestClock()
        let s = store(clock)
        for word in ["one", "two", "three", "four"] {
            s.apply(.caption(text: word, isFinal: false, channel: nil))
            clock.advance(1)
            s.apply(.caption(text: word, isFinal: true, channel: nil))
            clock.advance(1)
        }

        XCTAssertEqual(s.paragraphs.map(\.text), ["one two three four"])
    }

    func testAChannelChangeStartsANewParagraph() {
        let clock = TestClock()
        let s = store(clock)
        s.apply(.caption(text: "my turn", isFinal: true, channel: 0))
        clock.advance(1)
        s.apply(.caption(text: "their turn", isFinal: true, channel: 1))

        XCTAssertEqual(s.paragraphs.map(\.text), ["my turn", "their turn"])
    }

    func testPrependPutsARestoredTranscriptFirst() {
        let s = CaptionStore()
        s.prepend([TranscriptSegment(text: "earlier talk", channel: nil,
                                     at: "2026-07-10T18:00:00Z")])
        s.apply(.caption(text: "back again", isFinal: true, channel: nil))

        XCTAssertEqual(s.paragraphs.map(\.text), ["earlier talk", "back again"])
    }

    func testPrependArrivingAfterLiveCaptionsStillGoesFirst() {
        let s = CaptionStore()
        s.apply(.caption(text: "back again", isFinal: true, channel: nil))
        s.prepend([TranscriptSegment(text: "earlier talk", channel: nil,
                                     at: "2026-07-10T18:00:00Z")])

        XCTAssertEqual(s.paragraphs.map(\.text), ["earlier talk", "back again"])
    }

    /// A late restore must not break the sentence the user is in the middle of.
    func testPrependArrivingAfterLiveCaptionsDoesNotBreakTheLiveParagraph() {
        let clock = TestClock()
        let s = store(clock)
        s.apply(.caption(text: "okay where were we", isFinal: true, channel: nil))
        s.prepend([TranscriptSegment(text: "earlier talk", channel: nil,
                                     at: "2026-07-10T18:00:00Z")])
        clock.advance(1)
        s.apply(.caption(text: "on the budget", isFinal: true, channel: nil))

        XCTAssertEqual(s.paragraphs.map(\.text),
                       ["earlier talk", "okay where were we on the budget"])
    }

    func testPrependingNothingChangesNothing() {
        let s = CaptionStore()
        s.prepend([])

        XCTAssertTrue(s.paragraphs.isEmpty)
    }

    func testResetClearsAPendingBreak() {
        let clock = TestClock()
        let s = store(clock)
        s.apply(.caption(text: "before", isFinal: true, channel: nil))
        clock.advance(30)
        s.apply(.caption(text: "gap seen here", isFinal: false, channel: nil))
        s.reset()
        s.apply(.caption(text: "one", isFinal: true, channel: nil))
        clock.advance(1)
        s.apply(.caption(text: "two", isFinal: true, channel: nil))

        XCTAssertEqual(s.paragraphs.map(\.text), ["one two"])
    }
}
