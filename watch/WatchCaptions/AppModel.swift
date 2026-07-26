import Foundation
import CaptionCore

@MainActor
final class AppModel: ObservableObject {
    /// A screen pushed on top of the menu. Pushed views get a back chevron and
    /// the edge-swipe gesture for free; a swapped-out root view does not.
    enum Route: Hashable {
        case captions
        case history
        case detail(name: String)
    }

    /// Navigation stack above the menu.
    @Published var path: [Route] = []
    /// True while a session is capturing, which takes over the whole screen.
    @Published private(set) var capturing = false
    let store = CaptionStore()
    let history: HistoryStore

    /// The transcript the current session is writing to, once the relay names it.
    @Published private(set) var currentTranscript: String?
    /// The session offered under "Continue" on the menu.
    @Published private(set) var lastSession: LastSession?

    /// True when the last session ended by tapping Stop rather than by
    /// backgrounding. Stop is a decision, so it is never auto-resumed.
    private var stoppedExplicitly = false

    private let controller: SessionController
    private let relay: HTTPRelayClient
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let base = Self.httpBase(from: Secrets.relayURL)
        relay = HTTPRelayClient(base: base, token: Secrets.authToken)
        history = HistoryStore(client: RelayHistoryClient(base: base, token: Secrets.authToken))
        controller = SessionController(
            store: store,
            relay: relay,
            audio: AudioCapture(),
            permission: MicPermission()
        )
        lastSession = Self.loadLastSession(from: defaults)
        relay.onTranscript = { [weak self] name in self?.currentTranscript = name }
    }

    // MARK: - Launching

    /// Decide what opening the app does: pick up a conversation you glanced away
    /// from, or offer the menu.
    func launch() async {
        #if DEBUG
        // Lets a harness open a screen directly, since the watchOS simulator
        // offers no way to drive taps from the command line.
        if let forced = ProcessInfo.processInfo.arguments
            .drop(while: { $0 != "-startScreen" }).dropFirst().first {
            if forced == "history" { await showHistory(); return }
            if forced == "captions" { path = [.captions]; capturing = true; return }
            if forced == "detail" {
                await showHistory()
                if let first = history.items.first { await showDetail(name: first.name) }
                return
            }
        }
        #endif

        // Respect wherever the user navigated to; only a launch that lands on
        // the menu is eligible to auto-resume.
        guard !capturing, path.isEmpty else { return }

        switch launchAction(last: lastSession, now: Date(),
                            stoppedExplicitly: stoppedExplicitly) {
        case .resume(let name):
            await startCaptions(resuming: name)
        case .menu:
            break   // already on the menu
        }
    }

    // MARK: - Sessions

    func startNew() async {
        currentTranscript = nil
        await startCaptions(resuming: nil)
    }

    func continueLast() async {
        guard let name = lastSession?.transcriptName else { return }
        await startCaptions(resuming: name)
    }

    func resume(name: String) async {
        await startCaptions(resuming: name)
    }

    private func startCaptions(resuming name: String?) async {
        stoppedExplicitly = false
        currentTranscript = name
        path = [.captions]   // pushed, so it gets a back chevron like any screen
        capturing = true
        await controller.start(resuming: name)
    }

    /// End the session and remember it, so reopening can offer to continue.
    /// Ends the session deliberately: it will not be auto-resumed on reopen.
    func stop() {
        stoppedExplicitly = true
        endCapture()
        path = []
    }

    /// Navigating back leaves the session paused rather than ended, so it is
    /// still offered under "Continue last" and auto-resumes if you come
    /// straight back.
    func leaveCaptions() {
        guard capturing else { return }
        endCapture()
    }

    private func endCapture() {
        controller.stop()
        rememberCurrentSession()
        capturing = false
    }

    /// Backgrounding stops capture but keeps the session resumable — the relay
    /// holds the transcript open for ten minutes.
    func pause() {
        guard capturing else { return }
        controller.stop()
        rememberCurrentSession()
    }

    private func rememberCurrentSession() {
        guard let name = currentTranscript else { return }
        let session = LastSession(transcriptName: name, endedAt: Date())
        lastSession = session
        defaults.set(name, forKey: Keys.transcriptName)
        defaults.set(session.endedAt.timeIntervalSince1970, forKey: Keys.endedAt)
    }

    // MARK: - Navigation

    func showHistory() async {
        path = [.history]
        await history.load()
    }

    func showDetail(name: String) async {
        path.append(.detail(name: name))
        await history.loadDetail(name: name)
    }

    // MARK: - Persistence

    private enum Keys {
        static let transcriptName = "lastTranscriptName"
        static let endedAt = "lastSessionEndedAt"
    }

    private static func loadLastSession(from defaults: UserDefaults) -> LastSession? {
        guard let name = defaults.string(forKey: Keys.transcriptName) else { return nil }
        let ended = defaults.double(forKey: Keys.endedAt)
        guard ended > 0 else { return nil }
        return LastSession(transcriptName: name, endedAt: Date(timeIntervalSince1970: ended))
    }

    /// Derive the HTTPS origin (e.g. https://host) from the configured relay URL.
    private static func httpBase(from relayURL: URL) -> URL {
        var components = URLComponents(url: relayURL, resolvingAgainstBaseURL: false)!
        components.scheme = "https"
        components.path = ""
        components.query = nil
        return components.url!
    }
}
