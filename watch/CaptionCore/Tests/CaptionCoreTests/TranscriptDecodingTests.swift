import XCTest
@testable import CaptionCore

/// Decoding is pinned against the relay's real response shape, captured from
/// `GET /v1/transcripts` in production.
final class TranscriptDecodingTests: XCTestCase {
    func testDecodesTheListResponse() throws {
        let json: [String: Any] = ["transcripts": [
            ["name": "2026-07-19T16-15-19Z_492DFC4E", "startedAt": "2026-07-19T16:15:19.101Z",
             "segmentCount": 1055, "preview": "I think that God has given us",
             "hasSummary": true, "title": "Bible study: 1 Samuel 30"],
            ["name": "2026-07-13T16-34-46Z_1A5C4C33", "startedAt": "2026-07-13T16:34:46.500Z",
             "segmentCount": 3, "preview": "Live captions", "hasSummary": false],
        ]]

        let items = try decodeTranscriptList(json)

        XCTAssertEqual(items.count, 2)
        XCTAssertEqual(items[0].title, "Bible study: 1 Samuel 30")
        XCTAssertEqual(items[0].segmentCount, 1055)
        XCTAssertTrue(items[0].hasSummary)
        XCTAssertNil(items[1].title)
        XCTAssertFalse(items[1].hasSummary)
    }

    func testListRejectsAResponseWithoutTranscripts() {
        XCTAssertThrowsError(try decodeTranscriptList(["unexpected": true]))
    }

    func testListSkipsEntriesMissingAName() throws {
        let json: [String: Any] = ["transcripts": [
            ["startedAt": "2026-07-19T16:15:19Z"],
            ["name": "good", "startedAt": "2026-07-19T16:15:19Z"],
        ]]

        let items = try decodeTranscriptList(json)

        XCTAssertEqual(items.map(\.name), ["good"])
    }

    func testDecodesTheDetailResponse() {
        let json: [String: Any] = [
            "name": "2026-07-10T18-05-22Z_f9dd",
            "summary": "Title: Vendor call\n\nAn overview.",
            "segments": [
                ["at": "2026-07-10T18:05:22Z", "text": "hello there"],
                ["at": "2026-07-10T18:05:29Z", "text": "my line", "channel": 0],
                ["at": "2026-07-10T18:05:33Z", "text": "their line", "channel": 1],
            ],
        ]

        let detail = decodeTranscriptDetail(json, name: "2026-07-10T18-05-22Z_f9dd")

        XCTAssertEqual(detail.title, "Vendor call")
        XCTAssertEqual(detail.summaryBody, "An overview.")
        XCTAssertEqual(detail.segments.map(\.text), ["hello there", "my line", "their line"])
        XCTAssertEqual(detail.segments.map(\.channel), [nil, 0, 1])
    }

    func testDetailHandlesATranscriptWithNoSummary() {
        let json: [String: Any] = ["name": "a", "summary": NSNull(),
                                   "segments": [["at": "x", "text": "hello"]]]

        let detail = decodeTranscriptDetail(json, name: "a")

        XCTAssertNil(detail.title)
        XCTAssertNil(detail.summaryBody)
        XCTAssertEqual(detail.segments.count, 1)
    }

    func testDetailHandlesAnEmptyTranscript() {
        let detail = decodeTranscriptDetail(["name": "a"], name: "a")

        XCTAssertTrue(detail.segments.isEmpty)
        XCTAssertNil(detail.summaryBody)
    }

    func testDetailDecodesSegmentTimestamps() {
        let json: [String: Any] = [
            "segments": [
                ["at": "2026-07-10T18:05:22Z", "text": "hello"],
                ["text": "no timestamp"],
            ],
        ]

        let detail = decodeTranscriptDetail(json, name: "2026-07-10T18-05-22Z_f9dd")

        XCTAssertEqual(detail.segments.map(\.at), ["2026-07-10T18:05:22Z", nil])
    }
}
