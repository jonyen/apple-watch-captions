import XCTest
@testable import CaptionCore

@MainActor
final class SessionControllerTests: XCTestCase {

    final class FakeRelay: Relay {
        var onMessage: (@MainActor (ServerMessage) -> Void)?
        var onClose: (@MainActor () -> Void)?
        var connected = false
        var closed = false
        var sent: [Data] = []
        func connect() { connected = true }
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
        relay.deliver(.caption(text: "hi", isFinal: true))
        XCTAssertEqual(store.lines, ["hi"])
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
        XCTAssertTrue(audio.stopped)
        XCTAssertTrue(relay.closed)
    }
}
