import XCTest
@testable import CaptionCore

private struct FakeHistory: HistoryFetching {
    var items: [TranscriptListItem] = []
    var detail: TranscriptDetail?
    var listError: Error?
    var detailError: Error?

    func list() async throws -> [TranscriptListItem] {
        if let listError { throw listError }
        return items
    }

    func detail(name: String) async throws -> TranscriptDetail {
        if let detailError { throw detailError }
        guard let detail else { throw HistoryError.message("missing") }
        return detail
    }
}

private func item(_ name: String, title: String?) -> TranscriptListItem {
    TranscriptListItem(name: name, title: title, startedAt: "2026-07-10T18:05:22Z",
                       segmentCount: 3, hasSummary: title != nil)
}

@MainActor
final class HistoryStoreTests: XCTestCase {
    func testStartsIdle() {
        let store = HistoryStore(client: FakeHistory())
        XCTAssertEqual(store.listState, .idle)
        XCTAssertTrue(store.items.isEmpty)
    }

    func testLoadPopulatesItems() async {
        let fake = FakeHistory(items: [item("a", title: "A chat"), item("b", title: nil)])
        let store = HistoryStore(client: fake)

        await store.load()

        XCTAssertEqual(store.listState, .loaded)
        XCTAssertEqual(store.items.map(\.name), ["a", "b"])
    }

    func testLoadFailureSurfacesAMessage() async {
        let store = HistoryStore(client: FakeHistory(listError: HistoryError.message("offline")))

        await store.load()

        XCTAssertEqual(store.listState, .failed("offline"))
        XCTAssertTrue(store.items.isEmpty)
    }

    func testLoadDetailPopulatesTheSelectedTranscript() async {
        let detail = TranscriptDetail(
            name: "a", summary: "Title: A chat\n\nAn overview.",
            segments: [TranscriptSegment(text: "hello", channel: nil)])
        let store = HistoryStore(client: FakeHistory(detail: detail))

        await store.loadDetail(name: "a")

        XCTAssertEqual(store.detailState, .loaded)
        XCTAssertEqual(store.detail?.segments.map(\.text), ["hello"])
    }

    func testDetailStripsTheTitleLineFromTheSummaryBody() async {
        let detail = TranscriptDetail(
            name: "a", summary: "Title: A chat\n\nAn overview.", segments: [])
        let store = HistoryStore(client: FakeHistory(detail: detail))

        await store.loadDetail(name: "a")

        XCTAssertEqual(store.detail?.summaryBody, "An overview.")
        XCTAssertEqual(store.detail?.title, "A chat")
    }

    func testDetailFailureSurfacesAMessage() async {
        let store = HistoryStore(client: FakeHistory(detailError: HistoryError.message("gone")))

        await store.loadDetail(name: "a")

        XCTAssertEqual(store.detailState, .failed("gone"))
    }

    func testReloadingClearsAPreviousFailure() async {
        var fake = FakeHistory(listError: HistoryError.message("offline"))
        let store = HistoryStore(client: fake)
        await store.load()
        XCTAssertEqual(store.listState, .failed("offline"))

        fake.listError = nil
        fake.items = [item("a", title: "A chat")]
        let recovered = HistoryStore(client: fake)
        await recovered.load()

        XCTAssertEqual(recovered.listState, .loaded)
    }
}

final class TranscriptRowTests: XCTestCase {
    private let utc = TimeZone(identifier: "UTC")!

    func testTitledRowLeadsWithTheTitleAndShowsTheDateBeneath() {
        let row = TranscriptRow(item: item("a", title: "Vendor call about code review"), timeZone: utc)

        XCTAssertEqual(row.primary, "Vendor call about code review")
        XCTAssertEqual(row.secondary, "Jul 10, 6:05 PM")
    }

    func testUntitledRowFallsBackToTheDateWithNoSubheading() {
        let row = TranscriptRow(item: item("a", title: nil), timeZone: utc)

        XCTAssertEqual(row.primary, "Jul 10, 6:05 PM")
        XCTAssertNil(row.secondary)
    }

    func testUnparseableTimestampFallsBackToTheRawValue() {
        let broken = TranscriptListItem(name: "a", title: nil, startedAt: "not-a-date",
                                        segmentCount: 0, hasSummary: false)
        let row = TranscriptRow(item: broken, timeZone: utc)

        XCTAssertEqual(row.primary, "not-a-date")
    }
}
