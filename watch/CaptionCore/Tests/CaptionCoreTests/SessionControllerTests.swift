import XCTest
@testable import CaptionCore

@MainActor
final class SessionControllerTests: XCTestCase {

    final class FakeRelay: Relay {
        var onMessage: (@MainActor (ServerMessage) -> Void)?
        var onClose: (@MainActor () -> Void)?
        var connected = false
        var connectCount = 0
        /// The mode the last `connect` was handed, or nil if never connected.
        var mode: SessionMode?
        var closed = false
        var sent: [Data] = []
        func connect(mode: SessionMode) { connected = true; connectCount += 1; self.mode = mode }
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

    /// A `MicPermissionProviding` whose `ensureGranted()` calls block until a
    /// test releases them, so a `start` suspended mid-permission-check can be
    /// superseded deterministically instead of racing on real concurrency.
    /// Mirrors `GatedHistory`, split into a separate arrival wait and release
    /// since the caller needs to act (stop + start again) between the two.
    actor GatedPermission: MicPermissionProviding {
        private let granted: Bool
        private var registeredCalls = 0
        private var waiters: [CheckedContinuation<Void, Never>] = []
        private var arrivalWatchers: [(need: Int, continuation: CheckedContinuation<Void, Never>)] = []

        init(granted: Bool = true) { self.granted = granted }

        func ensureGranted() async -> Bool {
            await withCheckedContinuation { continuation in
                waiters.append(continuation)
                registeredCalls += 1
                notifyArrivals()
            }
            return granted
        }

        /// Waits until `count` calls have arrived, without releasing them.
        func waitForArrival(_ count: Int) async {
            if registeredCalls < count {
                await withCheckedContinuation { arrivalWatchers.append((count, $0)) }
            }
        }

        func releaseAll() {
            waiters.forEach { $0.resume() }
            waiters.removeAll()
        }

        private func notifyArrivals() {
            arrivalWatchers.removeAll { watcher in
                guard registeredCalls >= watcher.need else { return false }
                watcher.continuation.resume()
                return true
            }
        }
    }

    private func make(granted: Bool = true)
        -> (SessionController, CaptionStore, FakeRelay, FakeAudio) {
        let store = CaptionStore()
        let relay = FakeRelay()
        let audio = FakeAudio()
        let c = SessionController(store: store, relay: relay, audio: audio,
                                  permission: FakePermission(granted: granted))
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

    func testLiveModeReachesTheRelay() async {
        let relay = FakeRelay()
        let c = SessionController(store: CaptionStore(), relay: relay,
                                  audio: FakeAudio(), permission: FakePermission(granted: true))
        await c.start(mode: .live)
        XCTAssertEqual(relay.mode, .live)
    }

    func testLiveModeStillCapturesAudio() async {
        let relay = FakeRelay()
        let audio = FakeAudio()
        let c = SessionController(store: CaptionStore(), relay: relay,
                                  audio: audio, permission: FakePermission(granted: true))
        await c.start(mode: .live)
        relay.deliver(.ready)
        XCTAssertTrue(audio.started)
    }

    func testStartPassesTheTranscriptToResumeToTheRelay() async {
        let (controller, store, relay, _) = make()
        await controller.start(mode: .saved(resuming: "2026-07-25T09-00-00Z_abc"))
        XCTAssertEqual(relay.mode, .saved(resuming: "2026-07-25T09-00-00Z_abc"))
        XCTAssertEqual(store.state, .connecting)
    }

    func testStartWithoutResumeAsksForAFreshTranscript() async {
        let (controller, _, relay, _) = make()
        await controller.start()
        XCTAssertEqual(relay.mode, .saved(resuming: nil))
    }

    func testSessionTokenChangesAcrossStartAndStop() async {
        let (controller, _, _, _) = make()
        let beforeStart = controller.sessionToken

        await controller.start()
        let afterStart = controller.sessionToken
        XCTAssertNotEqual(beforeStart, afterStart)

        controller.stop()
        let afterStop = controller.sessionToken
        XCTAssertNotEqual(afterStart, afterStop)
        XCTAssertNotEqual(beforeStart, afterStop)
    }

    /// The mirror image of the stale-restore case a `TranscriptPrefiller`
    /// guards against, one step earlier: a `start` suspended in the
    /// permission check — before `running` even means anything about *which*
    /// session — must not go on to connect for its own stale session once a
    /// stop + second start have superseded it. `running` alone can't
    /// distinguish the two; only `sessionToken` can.
    func testASupersededStartDoesNotConnect() async {
        let permission = GatedPermission()
        let store = CaptionStore()
        let relay = FakeRelay()
        let audio = FakeAudio()
        let controller = SessionController(store: store, relay: relay, audio: audio,
                                            permission: permission)

        let staleStart = Task { await controller.start(mode: .saved(resuming: "stale")) }
        await permission.waitForArrival(1)

        controller.stop()
        let currentStart = Task { await controller.start(mode: .saved(resuming: "current")) }
        await permission.waitForArrival(2)

        // Release both permission checks together; order between them no
        // longer matters because the guard, not sequencing, must keep the
        // stale one from connecting.
        await permission.releaseAll()
        await staleStart.value
        await currentStart.value

        XCTAssertEqual(relay.connectCount, 1)
        XCTAssertEqual(relay.mode, .saved(resuming: "current"))
    }

    func testStartReturnsTrueWhenItConnects() async {
        let (c, _, relay, _) = make()
        let connected = await c.start()
        XCTAssertTrue(connected)
        XCTAssertTrue(relay.connected)
    }

    func testStartReturnsFalseWhenPermissionDenied() async {
        let (c, _, relay, _) = make(granted: false)
        let connected = await c.start()
        XCTAssertFalse(connected)
        XCTAssertFalse(relay.connected)
    }

    /// The return value, not `isRunning`, is what a caller must key
    /// follow-up work off (a `TranscriptPrefiller` restore, notably): by the
    /// time the stale call's `await` resumes, `isRunning` is true again for
    /// the *other* session the second `start` connected, so `isRunning`
    /// alone can't tell "my session is running" from "a session is running."
    /// Same race as `testASupersededStartDoesNotConnect`, asserting on the
    /// return value instead of the relay's observed connect count.
    func testStartReturnsWhetherThisCallWonTheRace() async {
        let permission = GatedPermission()
        let controller = SessionController(store: CaptionStore(), relay: FakeRelay(),
                                            audio: FakeAudio(), permission: permission)

        let staleStart = Task { await controller.start(mode: .saved(resuming: "stale")) }
        await permission.waitForArrival(1)

        controller.stop()
        let currentStart = Task { await controller.start(mode: .saved(resuming: "current")) }
        await permission.waitForArrival(2)

        await permission.releaseAll()
        let staleConnected = await staleStart.value
        let currentConnected = await currentStart.value

        XCTAssertFalse(staleConnected)
        XCTAssertTrue(currentConnected)
    }
}
