import Foundation
import WatchKit
import CaptionCore

@MainActor
final class AppModel: ObservableObject {
    /// A screen pushed on top of the menu. Pushed views get a back chevron and
    /// the edge-swipe gesture for free; a swapped-out root view does not.
    enum Route: Hashable {
        case captions
        case history
        case detail(name: String)
        /// Reading a phone call the relay is captioning.
        case call
    }

    /// Navigation stack above the menu.
    @Published var path: [Route] = []
    /// True while a session is capturing, which takes over the whole screen.
    @Published private(set) var capturing = false
    /// True when the session on screen is live-only. Drives the captions
    /// screen's indicator, and keeps the session out of "Continue last".
    @Published private(set) var live = false
    let store = CaptionStore()
    let history: HistoryStore

    /// The transcript the current session is writing to, once the relay names it.
    @Published private(set) var currentTranscript: String?
    /// The session offered under "Continue" on the menu.
    @Published private(set) var lastSession: LastSession?

    /// True when the last session ended by tapping Stop rather than by
    /// backgrounding. Stop is a decision, so it is never auto-resumed.
    /// Persisted (see `Keys.stoppedExplicitly`) so a cold launch — watchOS can
    /// terminate a suspended app between Stop and reopening — still sees it;
    /// otherwise a fresh `AppModel` would default to `false` and could
    /// auto-resume into a session the user just deliberately ended.
    private var stoppedExplicitly = false {
        didSet { defaults.set(stoppedExplicitly, forKey: Keys.stoppedExplicitly) }
    }

    private let controller: SessionController
    private let relay: HTTPRelayClient
    private let defaults: UserDefaults
    /// Waits for the relay to push a finished transcript to Notion.
    private let exports: ExportWatcher
    private let notifier = ExportNotifier()
    /// Reads a live phone call. Shares `store` with mic sessions — the two are
    /// never live at once.
    let callCaptions: CallCaptions
    private let callClient: RelayCallClient
    /// The foreground poll. Cancelled and replaced whenever a new wait starts.
    private var exportPoll: Task<Void, Never>?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let base = Self.httpBase(from: Secrets.relayURL)
        let historyClient = RelayHistoryClient(base: base, token: Secrets.authToken)
        relay = HTTPRelayClient(base: base, token: Secrets.authToken)
        history = HistoryStore(client: historyClient)
        exports = ExportWatcher(client: historyClient, defaults: defaults)
        let callClient = RelayCallClient(base: base, token: Secrets.authToken)
        self.callClient = callClient
        callCaptions = CallCaptions(client: callClient, store: store)
        controller = SessionController(
            store: store,
            relay: relay,
            audio: AudioCapture(),
            permission: MicPermission(),
            // Resuming a session restores its transcript; this reads it. Kept
            // off HistoryStore, whose `detail` belongs to the history screen.
            history: historyClient
        )
        lastSession = Self.loadLastSession(from: defaults)
        stoppedExplicitly = defaults.bool(forKey: Keys.stoppedExplicitly)
        relay.onTranscript = { [weak self] name in self?.currentTranscript = name }
    }

    // MARK: - Launching

    /// Decide what opening the app does: pick up a conversation you glanced away
    /// from, or offer the menu.
    func launch() async {
        // Before anything else, and outside the guards below: a session that
        // ended before the app was suspended may have reached Notion since, and
        // that is worth saying wherever the app happens to reopen.
        resumeExportWait()

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

        // A call in progress is the most likely reason the app is being opened
        // at all, so it wins over the menu and over resuming a past session.
        if await enterCallIfLive() { return }

        switch launchAction(last: lastSession, now: Date(),
                            stoppedExplicitly: stoppedExplicitly) {
        case .resume(let name):
            await startCaptions(mode: .saved(resuming: name))
        case .menu:
            break   // already on the menu
        }
    }

    // MARK: - Sessions

    /// Open call captions when the relay says a call is live. False on no call
    /// or on any failure, so an unreachable relay lands on the menu.
    private func enterCallIfLive() async -> Bool {
        guard let update = try? await callClient.poll(since: 0), update.active else {
            return false
        }
        path = [.call]
        callCaptions.start()
        return true
    }

    /// Leave call captions. The call itself is unaffected — this only stops
    /// reading it.
    func leaveCall() {
        callCaptions.stop()
        path = []
    }

    func startNew() async {
        currentTranscript = nil
        await startCaptions(mode: .saved(resuming: nil))
    }

    /// Caption without keeping anything: the relay writes no transcript, so
    /// there is nothing to resume, browse, or delete afterwards.
    func startLive() async {
        currentTranscript = nil
        await startCaptions(mode: .live)
    }

    func continueLast() async {
        guard let name = lastSession?.transcriptName else { return }
        await startCaptions(mode: .saved(resuming: name))
    }

    func resume(name: String) async {
        await startCaptions(mode: .saved(resuming: name))
    }

    /// Restart after a connection error, in the mode that failed. Retrying a
    /// live session must not quietly start recording one.
    func retry() async {
        if live {
            await startLive()
        } else {
            await startNew()
        }
    }

    private func startCaptions(mode: SessionMode) async {
        stoppedExplicitly = false
        if case .saved(let name) = mode {
            currentTranscript = name
            live = false
        } else {
            currentTranscript = nil
            live = true
        }
        path = [.captions]   // pushed, so it gets a back chevron like any screen
        capturing = true
        await controller.start(mode: mode)
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
        live = false
    }

    /// Stops capture and records the session: a saved session as resumable —
    /// the relay holds the transcript open for ten minutes — and a live
    /// session as deliberately ended, via `rememberCurrentSession`'s early
    /// return. Leaves `capturing`/`live` untouched, so this is not a
    /// substitute for `endCapture()`. Currently uncalled.
    func pause() {
        guard capturing else { return }
        controller.stop()
        rememberCurrentSession()
    }

    private func rememberCurrentSession() {
        // A live session leaves no transcript, so there is nothing to offer
        // under "Continue last" — and nothing to auto-resume into either.
        // Marking it as deliberately stopped keeps the next launch on the menu
        // rather than reviving whichever saved session preceded it, which would
        // read as the app ignoring the choice you just made.
        if live {
            stoppedExplicitly = true
            return
        }
        guard let name = currentTranscript else { return }
        let session = LastSession(transcriptName: name, endedAt: Date())
        lastSession = session
        defaults.set(name, forKey: Keys.transcriptName)
        defaults.set(session.endedAt.timeIntervalSince1970, forKey: Keys.endedAt)
        beginExportWait(for: name)
    }

    // MARK: - Notion export

    /// Start waiting for this transcript's Notion page. Nothing exists to link
    /// to yet — the relay summarizes and exports only after the session closes.
    private func beginExportWait(for name: String) {
        exports.track(name: name)
        startExportPoll()
    }

    /// Pick a wait back up on launch. A watch app is suspended within seconds
    /// of the wrist dropping, so most waits are finished by some later wake
    /// rather than by the poll that started them.
    private func resumeExportWait() {
        guard exports.pending != nil else { return }
        startExportPoll()
    }

    private func startExportPoll() {
        exportPoll?.cancel()
        exportPoll = Task { [weak self] in await self?.pollForExport() }
        scheduleExportRefresh()
    }

    /// Poll while the app is on screen. Suspension simply stops this task
    /// making progress; `checkPendingExport()` carries the wait from there.
    private func pollForExport() async {
        // Here rather than at the point the wait starts, so a prompt the user
        // never got to answer — the app can be suspended mid-session-end — is
        // asked again on the next launch instead of leaving the notification
        // silently undeliverable.
        await notifier.requestAuthorization()
        while !Task.isCancelled {
            switch await exports.poll() {
            case .exported(let transcript):
                await notifier.notify(transcript)
                return
            case .idle, .gaveUp:
                return
            case .waiting:
                try? await Task.sleep(
                    nanoseconds: UInt64(ExportWatcher.pollInterval * 1_000_000_000))
            }
        }
    }

    /// One check from a background wake, rescheduling while the wait is still
    /// live. Called by the app's background-refresh handler.
    func checkPendingExport() async {
        switch await exports.poll() {
        case .exported(let transcript):
            await notifier.notify(transcript)
        case .waiting:
            scheduleExportRefresh()
        case .idle, .gaveUp:
            break
        }
    }

    /// Ask watchOS to wake the app to check again. watchOS decides when it
    /// actually runs and budgets how often, so this is a fallback for a wait
    /// the foreground poll could not finish — not the primary path.
    private func scheduleExportRefresh() {
        WKApplication.shared().scheduleBackgroundRefresh(
            withPreferredDate: Date().addingTimeInterval(Self.exportRefreshDelay),
            userInfo: nil) { _ in }
    }

    /// Comfortably past a typical export (summary, then the Notion write),
    /// without asking watchOS for a wake it will refuse as too soon.
    private static let exportRefreshDelay: TimeInterval = 60

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
        static let stoppedExplicitly = "stoppedExplicitly"
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
