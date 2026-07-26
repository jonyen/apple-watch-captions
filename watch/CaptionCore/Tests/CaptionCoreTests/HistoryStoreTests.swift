import XCTest
@testable import CaptionCore

/// Records what the store asked the relay to delete. A box, because the client
/// protocol is `Sendable` and its methods cannot mutate the fake.
private final class DeleteLog: @unchecked Sendable {
    private(set) var names: [String] = []
    func record(_ name: String) { names.append(name) }
}

private struct FakeHistory: HistoryClient {
    var items: [TranscriptListItem] = []
    var detail: TranscriptDetail?
    var listError: Error?
    var detailError: Error?
    var deleteError: Error?
    let deleted = DeleteLog()

    func list() async throws -> [TranscriptListItem] {
        if let listError { throw listError }
        return items
    }

    func detail(name: String) async throws -> TranscriptDetail {
        if let detailError { throw detailError }
        guard let detail else { throw HistoryError.message("missing") }
        return detail
    }

    func delete(name: String) async throws {
        if let deleteError { throw deleteError }
        deleted.record(name)
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

    func testDeleteDropsTheRowAndTellsTheRelay() async {
        let fake = FakeHistory(items: [item("a", title: "A"), item("b", title: "B"),
                                       item("c", title: "C")])
        let store = HistoryStore(client: fake)
        await store.load()

        await store.delete(item("b", title: "B"))

        XCTAssertEqual(store.items.map(\.name), ["a", "c"])
        XCTAssertEqual(fake.deleted.names, ["b"])
        XCTAssertNil(store.deleteError)
    }

    func testFailedDeletePutsTheRowBackWhereItWas() async {
        let fake = FakeHistory(items: [item("a", title: "A"), item("b", title: "B"),
                                       item("c", title: "C")],
                               deleteError: HistoryError.message("relay down"))
        let store = HistoryStore(client: fake)
        await store.load()

        await store.delete(item("b", title: "B"))

        XCTAssertEqual(store.items.map(\.name), ["a", "b", "c"])
        XCTAssertEqual(store.deleteError, "relay down")
    }

    func testDismissingTheDeleteErrorClearsIt() async {
        let fake = FakeHistory(items: [item("a", title: "A")],
                               deleteError: HistoryError.message("relay down"))
        let store = HistoryStore(client: fake)
        await store.load()
        await store.delete(item("a", title: "A"))
        XCTAssertNotNil(store.deleteError)

        store.clearDeleteError()

        XCTAssertNil(store.deleteError)
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
