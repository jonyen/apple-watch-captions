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

    final class FakeWakeLock: DisplayWakeLocking {
        var acquireCount = 0
        var releaseCount = 0
        func acquire() { acquireCount += 1 }
        func release() { releaseCount += 1 }
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

    /// A `HistoryClient` whose `detail(name:)` calls all block until a test
    /// releases them, so two overlapping fetches from two sessions can be
    /// interleaved deterministically instead of racing on real concurrency.
    ///
    /// A naive "release the Nth call" design races: an unstructured `Task`'s
    /// body does not necessarily start running the moment it is created, so a
    /// release issued before a call has reached its suspension point is a
    /// silent no-op, and that call then hangs forever with nothing left to
    /// wake it. `releaseAllOnceArrived` avoids that by first waiting — inside
    /// this actor, so no polling — until the expected number of calls have
    /// actually registered, and only then resuming them.
    actor GatedHistory: HistoryClient {
        private let segments: [TranscriptSegment]
        private var registeredCalls = 0
        private var waiters: [CheckedContinuation<Void, Never>] = []
        private var arrivalWatchers: [(need: Int, continuation: CheckedContinuation<Void, Never>)] = []

        init(segments: [TranscriptSegment]) { self.segments = segments }

        func list() async throws -> [TranscriptListItem] { [] }

        func detail(name: String) async throws -> TranscriptDetail {
            await withCheckedContinuation { continuation in
                waiters.append(continuation)
                registeredCalls += 1
                notifyArrivals()
            }
            return TranscriptDetail(name: name, summary: nil, segments: segments)
        }

        func delete(name: String) async throws {}

        /// Waits for `count` calls to have arrived, then releases all of them
        /// at once.
        func releaseAllOnceArrived(_ count: Int) async {
            if registeredCalls < count {
                await withCheckedContinuation { arrivalWatchers.append((count, $0)) }
            }
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

    private func makeWaking(granted: Bool = true)
        -> (SessionController, FakeRelay, FakeWakeLock) {
        let relay = FakeRelay()
        let lock = FakeWakeLock()
        let c = SessionController(store: CaptionStore(), relay: relay, audio: FakeAudio(),
                                  permission: FakePermission(granted: granted),
                                  wakeLock: lock)
        return (c, relay, lock)
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

    func testLiveModeRestoresNoTranscript() async {
        let relay = FakeRelay()
        let store = CaptionStore()
        let history = FakeHistory(segments: [
            TranscriptSegment(text: "earlier talk", channel: nil, at: "2026-07-10T18:00:00Z")
        ])
        let c = SessionController(store: store, relay: relay,
                                  audio: FakeAudio(), permission: FakePermission(granted: true),
                                  history: history)
        await c.start(mode: .live)
        await c.waitForPrefill()
        XCTAssertTrue(store.paragraphs.isEmpty)
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

    private static let earlier = [
        TranscriptSegment(text: "earlier talk", channel: nil, at: "2026-07-10T18:00:00Z"),
    ]

    func testResumingRestoresThePreviousTranscript() async {
        let (controller, store, _, _) = make(history: FakeHistory(segments: Self.earlier))

        await controller.start(mode: .saved(resuming: "2026-07-10T18-00-00Z_abc"))
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

        await controller.start(mode: .saved(resuming: "2026-07-10T18-00-00Z_abc"))
        await controller.waitForPrefill()
        relay.deliver(.ready)

        XCTAssertTrue(store.paragraphs.isEmpty)
        XCTAssertEqual(store.state, .listening)
        XCTAssertTrue(audio.started)
    }

    func testASessionStoppedDuringTheRestoreIsNotPrefilled() async {
        let (controller, store, _, _) = make(history: FakeHistory(segments: Self.earlier))

        await controller.start(mode: .saved(resuming: "2026-07-10T18-00-00Z_abc"))
        controller.stop()
        await controller.waitForPrefill()

        XCTAssertTrue(store.paragraphs.isEmpty)
    }

    func testResumingWithoutAHistoryClientStillRuns() async {
        let (controller, store, relay, _) = make()

        await controller.start(mode: .saved(resuming: "2026-07-10T18-00-00Z_abc"))
        await controller.waitForPrefill()

        XCTAssertEqual(relay.mode, .saved(resuming: "2026-07-10T18-00-00Z_abc"))
        XCTAssertTrue(store.paragraphs.isEmpty)
    }

    /// A restore that is still in flight when its session stops must not land
    /// in a later session that resumes the same transcript. `stop()`'s cancel
    /// is only best-effort — the fetch can already be past cancellation and
    /// complete anyway — so the guard has to be able to tell "an old session's
    /// restore" apart from "the current session", not just "some session is
    /// running".
    func testAStaleRestoreDoesNotLandInALaterSession() async {
        let history = GatedHistory(segments: Self.earlier)
        let (controller, store, _, _) = make(history: history)

        await controller.start(mode: .saved(resuming: "2026-07-10T18-00-00Z_abc"))   // fetch 1: blocked
        controller.stop()
        await controller.start(mode: .saved(resuming: "2026-07-10T18-00-00Z_abc"))   // fetch 2: blocked

        // Release both fetches together; order between them no longer matters
        // because the guard, not sequencing, is what must keep the stale one out.
        await history.releaseAllOnceArrived(2)
        await controller.waitForPrefill()   // covers both the current and the superseded restore

        XCTAssertEqual(store.paragraphs.map(\.text), ["earlier talk"])
    }

    /// The mirror image of `testAStaleRestoreDoesNotLandInALaterSession`, one
    /// step earlier: a `start` suspended in the permission check — before
    /// `running` even means anything about *which* session — must not go on
    /// to connect for its own stale session once a stop + second start have
    /// superseded it. `running` alone can't distinguish the two; only
    /// `generation` can.
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

    func testAcquiresTheWakeLockWhenKeepAwakeIsSet() async {
        let (c, _, lock) = makeWaking()
        await c.start(keepAwake: true)
        XCTAssertEqual(lock.acquireCount, 1)
    }

    func testDoesNotAcquireTheWakeLockByDefault() async {
        let (c, relay, lock) = makeWaking()
        await c.start()
        XCTAssertTrue(relay.connected)
        XCTAssertEqual(lock.acquireCount, 0)
    }

    func testReleasesTheWakeLockOnStop() async {
        let (c, _, lock) = makeWaking()
        await c.start(keepAwake: true)
        c.stop()
        XCTAssertEqual(lock.releaseCount, 1)
    }

    /// A dropped connection ends the session without going through `stop()`.
    /// Without its own release the workout session — and the lit screen —
    /// would outlive the session that asked for it.
    func testReleasesTheWakeLockWhenTheConnectionDrops() async {
        let (c, relay, lock) = makeWaking()
        await c.start(keepAwake: true)
        relay.deliver(.ready)
        relay.dropConnection()
        XCTAssertEqual(lock.releaseCount, 1)
    }

    func testDoesNotAcquireTheWakeLockWhenTheMicIsDenied() async {
        let (c, _, lock) = makeWaking(granted: false)
        await c.start(keepAwake: true)
        XCTAssertEqual(lock.acquireCount, 0)
    }

    /// Mirrors `testASupersededStartDoesNotConnect`, one step further: a
    /// `start` whose permission check is still in flight when a stop + second
    /// start supersede it must not acquire the wake lock either. Without the
    /// post-await generation re-check, both the stale and current starts
    /// would call `acquire()` once their permission checks are released
    /// together, since both ask for `keepAwake: true` — so a passing
    /// `acquireCount == 1` here is only possible if the guard actually kept
    /// the superseded start from acquiring.
    func testASupersededStartDoesNotAcquireTheWakeLock() async {
        let permission = GatedPermission()
        let relay = FakeRelay()
        let lock = FakeWakeLock()
        let controller = SessionController(store: CaptionStore(), relay: relay, audio: FakeAudio(),
                                            permission: permission, wakeLock: lock)

        let staleStart = Task { await controller.start(mode: .saved(resuming: "stale"), keepAwake: true) }
        await permission.waitForArrival(1)

        controller.stop()
        let currentStart = Task { await controller.start(mode: .saved(resuming: "current"), keepAwake: true) }
        await permission.waitForArrival(2)

        // Release both permission checks together; order between them no
        // longer matters because the guard, not sequencing, must keep the
        // stale one from acquiring.
        await permission.releaseAll()
        await staleStart.value
        await currentStart.value

        XCTAssertEqual(lock.acquireCount, 1)
    }
}
