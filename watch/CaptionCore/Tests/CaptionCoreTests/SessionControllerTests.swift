import XCTest
@testable import CaptionCore

@MainActor
final class SessionControllerTests: XCTestCase {

    final class FakeRelay: Relay {
        var onMessage: (@MainActor (ServerMessage) -> Void)?
        var onClose: (@MainActor () -> Void)?
        var connected = false
        var resumedName: String??
        var closed = false
        var sent: [Data] = []
        func connect(resuming name: String?) { connected = true; resumedName = name }
        func send(_ audio: Data) { sent.append(audio) }
        func close() { closed = true }
        @MainActor func deliver(_ m: ServerMessage) { onMessage?(m) }
        @MainActor func dropConnection() { onClose?() }
    }

    final class FakeAudio: AudioCapturing {
        var started = false
        var stopped = false
        var chunkSink: ((Data) -> Void)?
        func start(onChunk: @escaping (Data) -> Void) throws { started = true; chunkSink = onChunk }
        func stop() { stopped = true }
    }

    struct FakePermission: MicPermissionProviding {
        let granted: Bool
        func ensureGranted() async -> Bool { granted }
    }

    struct FakeHistory: HistoryClient {
        var segments: [TranscriptSegment] = []
        var error: Error?

        func list() async throws -> [TranscriptListItem] { [] }
        func detail(name: String) async throws -> TranscriptDetail {
            if let error { throw error }
            return TranscriptDetail(name: name, summary: nil, segments: segments)
        }
        func delete(name: String) async throws {}
    }

    private func make(granted: Bool = true, history: HistoryClient? = nil)
        -> (SessionController, CaptionStore, FakeRelay, FakeAudio) {
        let store = CaptionStore()
        let relay = FakeRelay()
        let audio = FakeAudio()
        let c = SessionController(store: store, relay: relay, audio: audio,
                                  permission: FakePermission(granted: granted),
                                  history: history)
        return (c, store, relay, audio)
    }

    func testStartConnectsWhenPermitted() async {
        let (c, store, relay, _) = make()
        await c.start()
        XCTAssertTrue(relay.connected)
        XCTAssertEqual(store.state, .connecting)
    }

    func testStartFailsWhenPermissionDenied() async {
        let (c, store, relay, _) = make(granted: false)
        await c.start()
        XCTAssertFalse(relay.connected)
        if case .error = store.state {} else { XCTFail("expected error state") }
    }

    func testReadyStartsAudioAndListening() async {
        let (c, store, relay, audio) = make()
        await c.start()
        relay.deliver(.ready)
        XCTAssertEqual(store.state, .listening)
        XCTAssertTrue(audio.started)
    }

    func testAudioChunksAreSent() async {
        let (c, _, relay, audio) = make()
        await c.start()
        relay.deliver(.ready)
        audio.chunkSink?(Data([1, 2, 3]))
        XCTAssertEqual(relay.sent, [Data([1, 2, 3])])
    }

    func testCaptionUpdatesStore() async {
        let (c, store, relay, _) = make()
        await c.start()
        relay.deliver(.ready)
        relay.deliver(.caption(text: "hi", isFinal: true, channel: nil))
        XCTAssertEqual(store.paragraphs.map(\.text), ["hi"])
    }

    func testRelayErrorStopsAndShowsError() async {
        let (c, store, relay, audio) = make()
        await c.start()
        relay.deliver(.ready)
        relay.deliver(.error(message: "boom"))
        XCTAssertEqual(store.state, .error("boom"))
        XCTAssertTrue(audio.stopped)
        XCTAssertTrue(relay.closed)
    }

    func testUnexpectedCloseShowsConnectionLost() async {
        let (c, store, relay, audio) = make()
        await c.start()
        relay.deliver(.ready)
        relay.dropConnection()
        XCTAssertEqual(store.state, .error("Connection lost"))
        XCTAssertTrue(audio.stopped)
    }

    func testStopTearsDown() async {
        let (c, _, relay, audio) = make()
        await c.start()
        c.stop()
        XCTAssertFalse(audio.started)
        XCTAssertTrue(audio.stopped)
        XCTAssertTrue(relay.closed)
    }

    func testIgnoresMessagesAfterStop() async {
        let (c, store, relay, audio) = make()
        await c.start()
        c.stop()
        relay.deliver(.ready)
        XCTAssertFalse(audio.started)
        XCTAssertEqual(store.state, .connecting)
    }

    func testStartPassesTheTranscriptToResumeToTheRelay() async {
        let (controller, store, relay, _) = make()
        await controller.start(resuming: "2026-07-25T09-00-00Z_abc")
        XCTAssertEqual(relay.resumedName, "2026-07-25T09-00-00Z_abc")
        XCTAssertEqual(store.state, .connecting)
    }

    func testStartWithoutResumeAsksForAFreshTranscript() async {
        let (controller, _, relay, _) = make()
        await controller.start()
        XCTAssertEqual(relay.resumedName, String?.none)
    }

    private static let earlier = [
        TranscriptSegment(text: "earlier talk", channel: nil, at: "2026-07-10T18:00:00Z"),
    ]

    func testResumingRestoresThePreviousTranscript() async {
        let (controller, store, _, _) = make(history: FakeHistory(segments: Self.earlier))

        await controller.start(resuming: "2026-07-10T18-00-00Z_abc")
        await controller.waitForPrefill()

        XCTAssertEqual(store.paragraphs.map(\.text), ["earlier talk"])
    }

    func testANewSessionRestoresNothing() async {
        let (controller, store, _, _) = make(history: FakeHistory(segments: Self.earlier))

        await controller.start()
        await controller.waitForPrefill()

        XCTAssertTrue(store.paragraphs.isEmpty)
    }

    /// The session is the point. Missing scrollback is not worth an error over a
    /// working session.
    func testAFailedRestoreLeavesTheSessionRunning() async {
        let failing = FakeHistory(error: HistoryError.message("offline"))
        let (controller, store, relay, audio) = make(history: failing)

        await controller.start(resuming: "2026-07-10T18-00-00Z_abc")
        await controller.waitForPrefill()
        relay.deliver(.ready)

        XCTAssertTrue(store.paragraphs.isEmpty)
        XCTAssertEqual(store.state, .listening)
        XCTAssertTrue(audio.started)
    }

    func testASessionStoppedDuringTheRestoreIsNotPrefilled() async {
        let (controller, store, _, _) = make(history: FakeHistory(segments: Self.earlier))

        await controller.start(resuming: "2026-07-10T18-00-00Z_abc")
        controller.stop()
        await controller.waitForPrefill()

        XCTAssertTrue(store.paragraphs.isEmpty)
    }

    func testResumingWithoutAHistoryClientStillRuns() async {
        let (controller, store, relay, _) = make()

        await controller.start(resuming: "2026-07-10T18-00-00Z_abc")
        await controller.waitForPrefill()

        XCTAssertEqual(relay.resumedName, "2026-07-10T18-00-00Z_abc")
        XCTAssertTrue(store.paragraphs.isEmpty)
    }
}
