import Foundation

/// Orchestrates a listening session: permission → connect → wait `ready` → stream audio.
/// Wires relay messages into the store and audio chunks into the relay.
@MainActor
public final class SessionController {
    private let store: CaptionStore
    private let relay: Relay
    private let audio: AudioCapturing
    private let permission: MicPermissionProviding
    private let history: HistoryClient?
    /// Retained so tests can await the restore. The app never waits on it.
    private var prefillTask: Task<Void, Never>?
    /// The restore a new session superseded. Retained only so tests can await
    /// it; production never waits on either slot.
    private var supersededPrefillTask: Task<Void, Never>?
    private var running = false
    /// Identifies the current session. `prefillTask?.cancel()` is only a
    /// best-effort request — a fetch already in flight can still complete and
    /// deliver a result after the session that started it has ended, so
    /// `running` alone cannot tell that session apart from a later one that
    /// reused the flag. Bumped whenever a session starts or ends.
    private var generation = 0

    public init(store: CaptionStore, relay: Relay,
                audio: AudioCapturing, permission: MicPermissionProviding,
                history: HistoryClient? = nil) {
        self.store = store
        self.relay = relay
        self.audio = audio
        self.permission = permission
        self.history = history
        self.relay.onMessage = { [weak self] message in self?.handle(message) }
        self.relay.onClose = { [weak self] in self?.handleClose() }
    }

    /// Begin a session. Safe to call repeatedly; no-op if already running.
    /// `.saved(resuming:)` appends to an existing transcript instead of opening
    /// a new one — what the app does when you glance back mid-conversation.
    /// `.live` keeps nothing, so it never restores anything either.
    public func start(mode: SessionMode = .saved(resuming: nil)) async {
        guard !running else { return }
        running = true
        generation += 1
        let generation = self.generation
        store.reset()
        supersededPrefillTask = prefillTask
        prefillTask = nil
        guard await permission.ensureGranted() else {
            store.setError("Microphone access is off. Enable it in Settings › Privacy.")
            running = false
            return
        }
        // `running` alone can't tell this session apart from a stop+start that
        // reused the flag while we were suspended; compare generation too.
        guard running, self.generation == generation else { return }
        relay.connect(mode: mode)
        // Only a resumed saved session has scrollback to put back. The pattern
        // match is why `.live` needs no guard of its own.
        if case .saved(let name?) = mode { restorePreviousTranscript(named: name) }
    }

    /// End the session and tear down audio + transport.
    public func stop() {
        guard running else { return }
        running = false
        generation += 1
        prefillTask?.cancel()
        audio.stop()
        relay.close()
    }

    private func handle(_ message: ServerMessage) {
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
        generation += 1   // this session is over too; see the note on `generation`
        prefillTask?.cancel()
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

    /// Put the transcript being resumed back in the scroll, so a conversation
    /// you glanced away from reads continuously.
    ///
    /// Deliberately not awaited: the captions screen appears at once and the
    /// history fills in behind it. A failure is dropped — an error banner over a
    /// working session would be worse than missing scrollback.
    private func restorePreviousTranscript(named name: String) {
        guard let history else { return }
        let generation = self.generation
        prefillTask = Task { [weak self] in
            guard let segments = try? await history.detail(name: name).segments else { return }
            guard let self, self.running, self.generation == generation else { return }
            self.store.prepend(segments)
        }
    }

    /// Awaits the restore started by `start(mode:)`, including one that a
    /// later `start` superseded before it finished. Tests only — production
    /// never waits on either.
    func waitForPrefill() async {
        await supersededPrefillTask?.value
        await prefillTask?.value
    }
}
