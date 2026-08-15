import CaptionCore
import XCTest
@testable import CaptionRelay

@MainActor
final class TranscriptPrefillerTests: XCTestCase {

    final class FakeRelay: Relay {
        var onMessage: (@MainActor (CaptionEvent) -> Void)?
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
        @MainActor func deliver(_ m: CaptionEvent) { onMessage?(m) }
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

    private static let earlier = [
        TranscriptSegment(text: "earlier talk", channel: nil, at: "2026-07-10T18:00:00Z"),
    ]

    /// A started controller with fakes, mirroring the old tests' setup. The
    /// prefiller sits beside it, not inside it, so tests wire the two
    /// together the same way `AppModel` does.
    private func startedController(store: CaptionStore) async -> SessionController {
        let controller = SessionController(store: store, relay: FakeRelay(), audio: FakeAudio(),
                                           permission: FakePermission(granted: true))
        await controller.start(mode: .saved(resuming: "2026-07-10T18-00-00Z_abc"))
        return controller
    }

    func testRestorePrependsTheFetchedSegments() async {
        let store = CaptionStore()
        let controller = await startedController(store: store)
        let prefiller = TranscriptPrefiller(history: FakeHistory(segments: Self.earlier))

        prefiller.restore(name: "2026-07-10T18-00-00Z_abc", into: store, for: controller)
        await prefiller.waitForRestore()

        XCTAssertEqual(store.paragraphs.map(\.text), ["earlier talk"])
    }

    func testAFailedRestoreLeavesTheStoreUntouched() async {
        let store = CaptionStore()
        let controller = await startedController(store: store)
        let prefiller = TranscriptPrefiller(history: FakeHistory(error: HistoryError.message("offline")))

        prefiller.restore(name: "2026-07-10T18-00-00Z_abc", into: store, for: controller)
        await prefiller.waitForRestore()

        XCTAssertTrue(store.paragraphs.isEmpty)
        XCTAssertEqual(store.state, .connecting)
    }

    func testASessionStoppedDuringTheRestoreIsNotPrefilled() async {
        let store = CaptionStore()
        let controller = await startedController(store: store)
        let history = GatedHistory(segments: Self.earlier)
        let prefiller = TranscriptPrefiller(history: history)

        prefiller.restore(name: "2026-07-10T18-00-00Z_abc", into: store, for: controller)
        controller.stop()
        await history.releaseAllOnceArrived(1)
        await prefiller.waitForRestore()

        XCTAssertTrue(store.paragraphs.isEmpty)
    }

    /// A restore that is still in flight when its session stops must not land
    /// in a later session that resumes the same transcript. `stop()`'s cancel
    /// is only best-effort — the fetch can already be past cancellation and
    /// complete anyway — so the guard has to be able to tell "an old session's
    /// restore" apart from "the current session", not just "some session is
    /// running".
    func testAStaleRestoreDoesNotLandInALaterSession() async {
        let store = CaptionStore()
        let controller = await startedController(store: store)
        let history = GatedHistory(segments: Self.earlier)
        let prefiller = TranscriptPrefiller(history: history)

        prefiller.restore(name: "2026-07-10T18-00-00Z_abc", into: store, for: controller)   // fetch 1: blocked
        controller.stop()
        await controller.start(mode: .saved(resuming: "2026-07-10T18-00-00Z_abc"))
        prefiller.restore(name: "2026-07-10T18-00-00Z_abc", into: store, for: controller)   // fetch 2: blocked

        // Release both fetches together; order between them no longer matters
        // because the guard, not sequencing, is what must keep the stale one out.
        await history.releaseAllOnceArrived(2)
        await prefiller.waitForRestore()   // covers both the current and the superseded restore

        XCTAssertEqual(store.paragraphs.map(\.text), ["earlier talk"])
    }
}
