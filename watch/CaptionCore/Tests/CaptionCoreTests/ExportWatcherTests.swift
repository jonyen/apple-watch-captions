import XCTest
@testable import CaptionCore

private final class FakeExportClient: ExportStatusClient, @unchecked Sendable {
    var status = ExportStatus(exported: false, url: nil, title: nil)
    var error: Error?
    private(set) var asked: [String] = []

    func exportStatus(name: String) async throws -> ExportStatus {
        asked.append(name)
        if let error { throw error }
        return status
    }
}

@MainActor
final class ExportWatcherTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suite: String!

    override func setUp() {
        super.setUp()
        suite = "export-watcher-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        super.tearDown()
    }

    private func watcher(_ client: FakeExportClient,
                         now: @escaping () -> Date = Date.init) -> ExportWatcher {
        ExportWatcher(client: client, defaults: defaults, now: now)
    }

    private let ended = Date(timeIntervalSince1970: 1_000_000)

    func testPollingWithNothingTrackedAsksTheRelayNothing() async {
        let client = FakeExportClient()

        let result = await watcher(client).poll()

        XCTAssertEqual(result, .idle)
        XCTAssertEqual(client.asked, [])
    }

    func testWaitsWhileTheTranscriptHasNotReachedNotion() async {
        let client = FakeExportClient()
        let watcher = watcher(client, now: { self.ended })
        watcher.track(name: "2026-08-05T10-00-00")

        let result = await watcher.poll()

        XCTAssertEqual(result, .waiting)
        XCTAssertEqual(client.asked, ["2026-08-05T10-00-00"])
        XCTAssertNotNil(watcher.pending)
    }

    func testReportsTheExportAndStopsWaiting() async {
        let client = FakeExportClient()
        client.status = ExportStatus(
            exported: true, url: "https://notion.so/p1", title: "Sprint planning")
        let watcher = watcher(client, now: { self.ended })
        watcher.track(name: "t1")

        let result = await watcher.poll()

        XCTAssertEqual(result, .exported(ExportedTranscript(
            name: "t1", title: "Sprint planning", url: "https://notion.so/p1")))
        XCTAssertNil(watcher.pending, "a reported export must not be reported twice")
    }

    /// A dropped connection on a watch is ordinary — a wrist out of Bluetooth
    /// range is not evidence the export failed.
    func testATransientFailureKeepsWaiting() async {
        let client = FakeExportClient()
        client.error = HistoryError.message("offline")
        let watcher = watcher(client, now: { self.ended })
        watcher.track(name: "t1")

        let result = await watcher.poll()

        XCTAssertEqual(result, .waiting)
        XCTAssertNotNil(watcher.pending)
    }

    func testGivesUpOnceTheWindowHasPassed() async {
        let client = FakeExportClient()
        var now = ended
        let watcher = watcher(client, now: { now })
        watcher.track(name: "t1")

        now = ended.addingTimeInterval(ExportWatcher.window + 1)

        let result = await watcher.poll()

        XCTAssertEqual(result, .gaveUp)
        XCTAssertNil(watcher.pending)
        XCTAssertEqual(client.asked, [], "past the window there is nothing worth asking")
    }

    /// watchOS suspends a watch app seconds after the wrist drops, and can
    /// terminate it outright before the relay finishes exporting. The wait has
    /// to survive that or the notification simply never arrives.
    func testTheWaitSurvivesTheAppBeingTerminated() async {
        let client = FakeExportClient()
        watcher(client, now: { self.ended }).track(name: "t1")

        let relaunched = watcher(client, now: { self.ended })

        let result = await relaunched.poll()

        XCTAssertEqual(relaunched.pending, PendingExport(name: "t1", endedAt: ended))
        XCTAssertEqual(result, .waiting)
    }

    func testForgettingClearsThePersistedWait() async {
        let client = FakeExportClient()
        let watcher = watcher(client, now: { self.ended })
        watcher.track(name: "t1")

        watcher.forget()

        XCTAssertNil(watcher.pending)
        XCTAssertNil(self.watcher(client, now: { self.ended }).pending)
    }

    /// Starting a new session replaces the wait: the old transcript's page may
    /// still be landing, but the newest session is the one worth a notification.
    func testTrackingAgainReplacesThePreviousWait() async {
        let client = FakeExportClient()
        let watcher = watcher(client, now: { self.ended })
        watcher.track(name: "t1")

        watcher.track(name: "t2")

        XCTAssertEqual(watcher.pending?.name, "t2")
    }

    /// Sessions too short to be worth summarizing are never exported, and a
    /// session that captured nothing leaves no transcript at all. Both are the
    /// likeliest thing to follow a quick test of the feature — waiting the full
    /// window on either burns background wakes to say nothing.
    func testStopsWaitingOnATranscriptThatWillNeverExport() async {
        let client = FakeExportClient()
        client.status = ExportStatus(exported: false, eligible: false, url: nil, title: nil)
        let watcher = watcher(client, now: { self.ended })
        watcher.track(name: "t1")

        let result = await watcher.poll()

        XCTAssertEqual(result, .gaveUp)
        XCTAssertNil(watcher.pending)
    }

    func testAnUnavailableTranscriptEndsTheWait() async {
        let client = FakeExportClient()
        client.status = .unavailable
        let watcher = watcher(client, now: { self.ended })
        watcher.track(name: "t1")

        let result = await watcher.poll()

        XCTAssertEqual(result, .gaveUp)
    }

    func testAnExportWithoutASummaryStillReports() async {
        let client = FakeExportClient()
        client.status = ExportStatus(exported: true, url: "https://notion.so/p1", title: nil)
        let watcher = watcher(client, now: { self.ended })
        watcher.track(name: "t1")

        let result = await watcher.poll()

        XCTAssertEqual(result, .exported(ExportedTranscript(
            name: "t1", title: nil, url: "https://notion.so/p1")))
    }
}

final class ExportStatusDecodingTests: XCTestCase {
    func testDecodesAnExportedTranscript() {
        let status = decodeExportStatus([
            "exported": true,
            "url": "https://notion.so/p1",
            "title": "Sprint planning",
            "exportedAt": "2026-08-05T10:00:00Z",
        ])

        XCTAssertEqual(status, ExportStatus(
            exported: true, url: "https://notion.so/p1", title: "Sprint planning"))
    }

    func testDecodesATranscriptStillWaiting() {
        let status = decodeExportStatus(["exported": false, "eligible": true])

        XCTAssertEqual(status, ExportStatus(exported: false, url: nil, title: nil))
        XCTAssertTrue(status.eligible)
    }

    func testDecodesATranscriptThatWillNeverExport() {
        XCTAssertFalse(decodeExportStatus(["exported": false, "eligible": false]).eligible)
    }

    /// A relay too old to send the field may still export, so the safe reading
    /// is "keep waiting" — never "give up".
    func testAMissingEligibleFieldReadsAsStillPossible() {
        XCTAssertTrue(decodeExportStatus(["exported": false]).eligible)
    }

    /// A relay too old to know the endpoint answers something else entirely;
    /// reading that as "exported" would fire a notification linking nowhere.
    func testAnUnexpectedResponseReadsAsNotExported() {
        XCTAssertEqual(decodeExportStatus(["error": "not found"]),
                       ExportStatus(exported: false, url: nil, title: nil))
    }

    func testAnExportedFlagWithNoURLReadsAsNotExported() {
        XCTAssertEqual(decodeExportStatus(["exported": true]),
                       ExportStatus(exported: false, url: nil, title: nil))
    }
}
