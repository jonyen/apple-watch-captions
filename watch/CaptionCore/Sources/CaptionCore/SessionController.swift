import Foundation

/// Orchestrates a listening session: permission → connect → wait `ready` → stream audio.
/// Wires relay messages into the store and audio chunks into the relay.
@MainActor
public final class SessionController {
    private let store: CaptionStore
    private let relay: CaptionEngine
    private let audio: AudioCapturing
    private let permission: MicPermissionProviding
    private var running = false
    /// Identifies the current session across suspension points. Regenerated
    /// whenever a session starts or ends, so work an earlier session started
    /// (a history restore, a stale callback) can recognize the world has
    /// moved on and drop its result. `stop()` is only a best-effort signal —
    /// a fetch already in flight can still complete afterwards, so
    /// `isRunning` alone cannot tell one session from the next.
    public private(set) var sessionToken = UUID()
    /// True while a session is running; pairs with `sessionToken` to let
    /// code outside the controller guard async work the way it does.
    public var isRunning: Bool { running }

    public init(store: CaptionStore, relay: CaptionEngine,
                audio: AudioCapturing, permission: MicPermissionProviding) {
        self.store = store
        self.relay = relay
        self.audio = audio
        self.permission = permission
        self.relay.onEvent = { [weak self] message in self?.handle(message) }
        self.relay.onClose = { [weak self] in self?.handleClose() }
    }

    /// Begin a session. Safe to call repeatedly; no-op if already running.
    ///
    /// Returns whether *this call* connected — false if the controller was
    /// already running, permission was denied, or a later `start`/`stop`
    /// superseded this one while it sat suspended on the permission check.
    /// Callers that key follow-up work off the session having connected (a
    /// `TranscriptPrefiller` restore, notably) must gate on this return value
    /// rather than `isRunning`: by the time a superseded call's `await`
    /// resumes, `isRunning` can be true again for a *different* session that
    /// a stop+start already started, and `isRunning` alone can't tell the two
    /// apart — only knowing whether this particular call won the race can.
    @discardableResult
    public func start() async -> Bool {
        guard !running else { return false }
        running = true
        sessionToken = UUID()
        let token = sessionToken
        store.reset()
        guard await permission.ensureGranted() else {
            store.setError("Microphone access is off. Enable it in Settings › Privacy.")
            running = false
            return false
        }
        // `running` alone can't tell this session apart from a stop+start that
        // reused the flag while we were suspended; compare the token too.
        guard running, sessionToken == token else { return false }
        relay.start()
        return true
    }

    /// End the session and tear down audio + transport.
    public func stop() {
        guard running else { return }
        running = false
        sessionToken = UUID()
        audio.stop()
        relay.close()
    }

    private func handle(_ message: CaptionEvent) {
        guard running else { return }
        store.apply(message)
        switch message {
        case .ready: startAudio()
        case .error: stop()
        case .caption: break
        }
    }

    private func handleClose() {
        guard running else { return }
        running = false
        sessionToken = UUID()   // this session is over too; see the note on `sessionToken`
        store.setError("Connection lost")
        audio.stop()
    }

    private func startAudio() {
        let relay = self.relay   // capture directly; onChunk runs off the main actor
        do {
            try audio.start(onChunk: { data in relay.send(data) })
        } catch {
            store.setError("Microphone error")
            stop()
        }
    }
}
