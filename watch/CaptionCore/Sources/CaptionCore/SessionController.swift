import Foundation

/// Orchestrates a listening session: permission → connect → wait `ready` → stream audio.
/// Wires relay messages into the store and audio chunks into the relay.
@MainActor
public final class SessionController {
    private let store: CaptionStore
    private let relay: Relay
    private let audio: AudioCapturing
    private let permission: MicPermissionProviding
    private var running = false

    public init(store: CaptionStore, relay: Relay,
                audio: AudioCapturing, permission: MicPermissionProviding) {
        self.store = store
        self.relay = relay
        self.audio = audio
        self.permission = permission
        self.relay.onMessage = { [weak self] message in self?.handle(message) }
        self.relay.onClose = { [weak self] in self?.handleClose() }
    }

    /// Begin a session. Safe to call repeatedly; no-op if already running.
    public func start() async {
        guard !running else { return }
        running = true
        store.reset()
        guard await permission.ensureGranted() else {
            store.setError("Microphone access is off. Enable it in Settings › Privacy.")
            running = false
            return
        }
        guard running else { return }   // stopped during the await
        relay.connect()
    }

    /// End the session and tear down audio + transport.
    public func stop() {
        guard running else { return }
        running = false
        audio.stop()
        relay.close()
    }

    private func handle(_ message: ServerMessage) {
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
