import XCTest
@testable import CaptionCore

final class ParagraphsTests: XCTestCase {
    private func segment(_ text: String, _ at: String?, channel: Int? = nil) -> TranscriptSegment {
        TranscriptSegment(text: text, channel: channel, at: at)
    }

    func testJoinsSegmentsInsideTheThresholdIntoOneParagraph() {
        let paragraphs = buildParagraphs(from: [
            segment("i went to the store", "2026-07-10T18:00:00Z"),
            segment("and it was closed", "2026-07-10T18:00:04Z"),
        ])

        XCTAssertEqual(paragraphs.map(\.text), ["i went to the store and it was closed"])
    }

    func testBreaksOnAGapPastTheThreshold() {
        let paragraphs = buildParagraphs(from: [
            segment("so that happened", "2026-07-10T18:00:00Z"),
            segment("anyway where were we", "2026-07-10T18:00:20Z"),
        ])

        XCTAssertEqual(paragraphs.map(\.text), ["so that happened", "anyway where were we"])
    }

    func testAGapExactlyAtTheThresholdBreaks() {
        let paragraphs = buildParagraphs(from: [
            segment("one", "2026-07-10T18:00:00Z"),
            segment("two", "2026-07-10T18:00:08Z"),
        ])

        XCTAssertEqual(paragraphs.map(\.text), ["one", "two"])
    }

    func testBreaksOnAChannelChange() {
        let paragraphs = buildParagraphs(from: [
            segment("my turn", "2026-07-10T18:00:00Z", channel: 0),
            segment("their turn", "2026-07-10T18:00:01Z", channel: 1),
        ])

        XCTAssertEqual(paragraphs.map(\.text), ["my turn", "their turn"])
        XCTAssertEqual(paragraphs.map(\.channel), [0, 1])
    }

    func testSegmentsWithoutTimestampsStayInOneParagraph() {
        let paragraphs = buildParagraphs(from: [segment("one", nil), segment("two", nil)])

        XCTAssertEqual(paragraphs.map(\.text), ["one two"])
    }

    func testMeasuresTheGapFromTheLastSegmentThatHadATimestamp() {
        let paragraphs = buildParagraphs(from: [
            segment("one", "2026-07-10T18:00:00Z"),
            segment("two", nil),
            segment("three", "2026-07-10T18:00:30Z"),
        ])

        XCTAssertEqual(paragraphs.map(\.text), ["one two", "three"])
    }

    func testParsesFractionalSecondTimestamps() {
        let paragraphs = buildParagraphs(from: [
            segment("one", "2026-07-10T18:00:00.500Z"),
            segment("two", "2026-07-10T18:00:20.250Z"),
        ])

        XCTAssertEqual(paragraphs.map(\.text), ["one", "two"])
    }

    func testSkipsEmptySegments() {
        let paragraphs = buildParagraphs(from: [
            segment("", "2026-07-10T18:00:00Z"),
            segment("real", "2026-07-10T18:00:01Z"),
        ])

        XCTAssertEqual(paragraphs.map(\.text), ["real"])
    }

    func testNoSegmentsProduceNoParagraphs() {
        XCTAssertTrue(buildParagraphs(from: []).isEmpty)
    }

    func testEachParagraphGetsItsOwnIdentity() {
        let paragraphs = buildParagraphs(from: [
            segment("one", "2026-07-10T18:00:00Z"),
            segment("two", "2026-07-10T18:00:20Z"),
        ])

        XCTAssertNotEqual(paragraphs[0].id, paragraphs[1].id)
    }
}
