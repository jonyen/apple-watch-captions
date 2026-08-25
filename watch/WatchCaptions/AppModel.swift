import Foundation
import WatchKit
import CaptionCore
import CaptionRelay
import CaptionRelayLive

@MainActor
final class AppModel: ObservableObject {
    /// A screen pushed on top of the menu. Pushed views get a back chevron and
    /// the edge-swipe gesture for free; a swapped-out root view does not.
    enum Route: Hashable {
        case captions
        case history
        case detail(name: String)
        /// Typing in the code the iPhone is showing, to merge this watch's
        /// account into it.
        case pairing
    }

    /// Navigation stack above the menu.
    @Published var path: [Route] = []
    /// True while a session is capturing, which takes over the whole screen.
    @Published private(set) var capturing = false
    /// True when the session on screen keeps nothing by itself — live-only,
    /// or on-device. Drives the relay sessions' indicator, and marks a
    /// session that ends without a named transcript as deliberately ended
    /// (see `rememberCurrentSession` — a kept on-device session whose
    /// transcript the relay did name is remembered despite this flag).
    @Published private(set) var live = false

    // MARK: - Home-screen toggles

    /// The home screen's "On device" toggle: compute captions on the watch
    /// itself instead of streaming audio to the relay. Persisted, like
    /// `lastSession`, so the choice survives launches.
    @Published var onDeviceEnabled: Bool {
        didSet { defaults.set(onDeviceEnabled, forKey: Keys.onDeviceEnabled) }
    }
    /// The home screen's "Keep transcripts" toggle: whether a session leaves
    /// a transcript. Defaults to on — the app's original promise — until the
    /// user says otherwise; persisted the same way.
    @Published var keepTranscripts: Bool {
        didSet { defaults.set(keepTranscripts, forKey: Keys.keepTranscripts) }
    }
    let store = CaptionStore()
    let history: HistoryStore

    /// The transcript the current session is writing to, once the relay names it.
    @Published private(set) var currentTranscript: String?
    /// The session Start may offer to resume.
    @Published private(set) var lastSession: LastSession?

    /// True when the last session ended by tapping Stop rather than by
    /// backgrounding. Stop is a decision, so it is never offered for resuming.
    /// Persisted (see `Keys.stoppedExplicitly`) so a cold launch — watchOS can
    /// terminate a suspended app between Stop and reopening — still sees it;
    /// otherwise a fresh `AppModel` would default to `false` and could offer
    /// to resume a session the user just deliberately ended.
    private var stoppedExplicitly = false {
        didSet { defaults.set(stoppedExplicitly, forKey: Keys.stoppedExplicitly) }
    }

    private let controller: SessionController
    private let relay: HTTPRelayClient
    private let micPermission = MicPermission()
    private let defaults: UserDefaults
    /// Waits for the relay to push a finished transcript to Notion.
    private let exports: ExportWatcher
    private let notifier = ExportNotifier()
    /// The on-device session. Its own controller and engine — Moonshine on
    /// Core ML instead of the relay — but the same store and the same mic.
    private let onDeviceController: SessionController
    /// The on-device engine behind `onDeviceController`: Moonshine, plus a
    /// per-session caption uploader when the session is kept. Held here so a
    /// start can set `keep` before connecting, the way `relay.mode` is set.
    private let onDeviceEngine: SavedOnDeviceEngine
    /// Restores a resumed session's scrollback behind `controller`. Kept off
    /// `SessionController` itself so a fetch that outlives its session has
    /// somewhere to be guarded without the controller knowing history exists.
    private let prefiller: TranscriptPrefiller
    private let settingsClient: RelaySettingsClient
    /// Task 5's relay-backed conformance to `PairingClient`. Owned here, not
    /// `private`, so `PairingView` — which calls `claim(code:)` itself rather
    /// than routing it through `AppModel` — can be handed it directly, the
    /// same way `history` is.
    let pairingClient: PairingClient
    /// What the phone last said. Defaults until the relay answers, so the app
    /// works unchanged when it cannot be reached.
    @Published private(set) var settings: Settings = .defaults
    /// True while the running mic session is the on-device one, so Stop,
    /// retry and the indicator address the right controller.
    @Published private(set) var onDevice = false
    /// True once an on-device session's lines are known to be reaching the
    /// relay — the uploader's first acknowledged send flips it, and a later
    /// socket failure flips it back. The captions screen shows the not-saved
    /// indicator until this is true, so it never claims persistence it does
    /// not have; the cost is a beat of "not saved" at the start of a kept
    /// session while the socket connects.
    @Published private(set) var onDeviceKept = false
    /// Whether the running on-device session asked to be kept, so `retry()`
    /// restarts the same kind of session that failed.
    private var onDeviceKeep = false
    /// The foreground poll. Cancelled and replaced whenever a new wait starts.
    private var exportPoll: Task<Void, Never>?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        onDeviceEnabled = defaults.bool(forKey: Keys.onDeviceEnabled)
        // Absent means on: saving is the default the app has always had, and
        // `bool(forKey:)` alone would silently read absence as off.
        keepTranscripts = defaults.object(forKey: Keys.keepTranscripts) == nil
            ? true : defaults.bool(forKey: Keys.keepTranscripts)
        let base = RelayOrigin.http(from: Secrets.relayURL)
        // A provider, not a resolved `String`: `init` is synchronous and
        // constructs every relay client eagerly, but the token comes from
        // `DeviceIdentity`, whose `token()` is `async throws` (it may need to
        // register this device with the relay on first launch). Each client
        // now holds this closure and resolves it per request instead of a
        // stored secret — see `HTTPRelayClient`'s doc comment.
        let token: @Sendable () async throws -> String = { try await DeviceIdentity.shared.token() }
        let historyClient = RelayHistoryClient(base: base, token: token)
        relay = HTTPRelayClient(base: base, token: token)
        history = HistoryStore(client: historyClient)
        exports = ExportWatcher(client: historyClient, defaults: defaults)
        controller = SessionController(
            store: store,
            relay: relay,
            audio: AudioCapture(),
            permission: micPermission
        )
        onDeviceEngine = SavedOnDeviceEngine(
            engine: OnDeviceEngine(),
            makeUploader: { CaptionUploader(token: token) })
        onDeviceController = SessionController(
            store: store,
            relay: onDeviceEngine,
            audio: AudioCapture(),
            permission: micPermission)
        // Resuming a session restores its transcript; this reads it. Kept off
        // HistoryStore, whose `detail` belongs to the history screen.
        prefiller = TranscriptPrefiller(history: historyClient)
        settingsClient = RelaySettingsClient(base: base, token: token)
        // `RelayPairingClient` is Task 5's deliverable (`CaptionRelayLive`),
        // built the same way `RelayDeviceRegistrar` is: the pure protocol
        // lives in `CaptionRelay`, the networked conformance beside it here.
        pairingClient = RelayPairingClient(base: base, token: token)
        lastSession = Self.loadLastSession(from: defaults)
        stoppedExplicitly = defaults.bool(forKey: Keys.stoppedExplicitly)
        relay.onTranscript = { [weak self] name in self?.currentTranscript = name }
        onDeviceEngine.onKept = { [weak self] kept in self?.onDeviceKept = kept }
        // A kept on-device session learns its relay transcript's name from
        // the caption uploader's first acknowledged post — the same
        // bookkeeping the relay engine's onTranscript feeds, so
        // `rememberCurrentSession` can offer to resume the transcript later.
        onDeviceEngine.onTranscript = { [weak self] name in self?.currentTranscript = name }
    }

    // MARK: - Launching

    /// Ready the app for the menu it always lands on. Resuming a recent
    /// session is now a choice made on Start (see `shouldOfferResume`), never
    /// something a launch does silently.
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

        // Respect wherever the user navigated to.
        guard !capturing, path.isEmpty else { return }

        // Settings decide what Start and the captions screen do.
        settings = await settingsClient.settings()
    }

    // MARK: - Sessions

    /// True when tapping Start should ask about the previous session first:
    /// the toggles are set to the kept-relay mode — the only one that can
    /// continue a saved transcript; an on-device or unkept Start just starts
    /// — and the previous session ended less than ten minutes ago (the window
    /// the relay holds a transcript open, the same 600 s caption-core's
    /// `launchAction` reasons about) without being explicitly stopped. Stop
    /// is a decision, so a stopped session is never offered.
    var shouldOfferResume: Bool {
        guard !onDeviceEnabled, keepTranscripts else { return false }
        guard !stoppedExplicitly, let last = lastSession else { return false }
        return Date().timeIntervalSince(last.endedAt) < Self.resumeWindow
    }

    /// Start a session the way the two home-screen toggles ask. The four
    /// combinations map onto the four kinds of session the app already knew,
    /// plus the one new one: kept and on-device.
    func start() async {
        switch (onDeviceEnabled, keepTranscripts) {
        case (false, true): await startNew()
        case (false, false): await startLive()
        case (true, false): await startOnDevice()
        case (true, true): await startSavedOnDevice()
        }
    }

    /// How long a just-ended session stays offerable, matching the relay's
    /// resume window.
    private static let resumeWindow: TimeInterval = 600

    /// Start a relay session in whichever mode the phone's settings ask for.
    /// With transcripts off there, Start keeps nothing — the same promise the
    /// "Keep transcripts" toggle makes, applied from the other end.
    func startNew() async {
        currentTranscript = nil
        await startCaptions(mode: settings.saveTranscripts ? .saved(resuming: nil) : .live)
    }

    /// Caption without keeping anything: the relay writes no transcript, so
    /// there is nothing to resume, browse, or delete afterwards.
    func startLive() async {
        currentTranscript = nil
        await startCaptions(mode: .live)
    }

    /// Caption on the watch itself, keeping nothing: no relay, no transcript.
    func startOnDevice() async {
        await startOnDeviceSession(keep: false)
    }

    /// Caption on the watch itself, forwarding each final line to the relay
    /// so the transcript is stored — and summarized and exported — like any
    /// saved session. If the relay cannot be reached the session degrades to
    /// unkept rather than failing: captions continue locally and the screen
    /// keeps the not-saved indicator (see `onDeviceKept`).
    func startSavedOnDevice() async {
        await startOnDeviceSession(keep: true)
    }

    private func startOnDeviceSession(keep: Bool) async {
        stoppedExplicitly = false
        currentTranscript = nil
        // A kept on-device session leaves a relay transcript, and the HTTP
        // caption path names it to the watch (the old WebSocket path never
        // did). `live` still marks the session as keeping nothing *by
        // itself*: if no post is ever acknowledged there is no name, and
        // `rememberCurrentSession` then treats the session as deliberately
        // ended rather than offering some older relay session afterwards.
        live = true
        onDevice = true
        onDeviceKeep = keep
        onDeviceKept = false
        onDeviceEngine.keep = keep
        path = [.captions]
        capturing = true
        await onDeviceController.start()
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
        if onDevice {
            await startOnDeviceSession(keep: onDeviceKeep)
        } else if live {
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
        relay.mode = mode
        // Gated on whether THIS call connected, not `controller.isRunning`:
        // a call superseded while suspended on the permission check can
        // resume after a later start already connected a different session,
        // and `isRunning` alone can't tell the two apart — it would restore
        // this call's `name` into that other session's transcript.
        let started = await controller.start()
        if started, case .saved(let name?) = mode {
            prefiller.restore(name: name, into: store, for: controller)
        }
    }

    /// End the session and remember it, so tapping Start again can offer to
    /// continue. Ends the session deliberately: it will not be offered.
    func stop() {
        stoppedExplicitly = true
        endCapture()
        path = []
    }

    /// Navigating back leaves the session paused rather than ended, so Start
    /// still offers it while it stays fresh.
    func leaveCaptions() {
        guard capturing else { return }
        endCapture()
    }

    private func endCapture() {
        if onDevice {
            onDeviceController.stop()
        } else {
            controller.stop()
            prefiller.cancel()
        }
        rememberCurrentSession()
        capturing = false
        live = false
        onDevice = false
        onDeviceKept = false
    }

    /// Stops capture and records the session: a saved session as resumable —
    /// the relay holds the transcript open for ten minutes — and a live
    /// session as deliberately ended, via `rememberCurrentSession`'s early
    /// return. Leaves `capturing`/`live` untouched, so this is not a
    /// substitute for `endCapture()`. Currently uncalled.
    func pause() {
        guard capturing else { return }
        (onDevice ? onDeviceController : controller).stop()
        prefiller.cancel()
        rememberCurrentSession()
    }

    private func rememberCurrentSession() {
        // The transcript name is what decides whether there is anything to
        // offer on Start. A kept on-device session gets one from the caption
        // uploader's HTTP responses (see `onDeviceEngine.onTranscript`), so
        // despite `live` it is recorded like any saved session — switching
        // the toggles back to relay mode within the window offers to resume
        // it, and the relay appends to the same transcript. Without a name —
        // a genuinely live session, an unkept on-device one, or a kept one
        // whose posts never reached the relay — there is nothing to offer,
        // and marking the session deliberately ended keeps the next Start
        // from offering whichever saved session preceded it, which would
        // read as the app ignoring the choice you just made.
        guard let name = currentTranscript else {
            if live { stoppedExplicitly = true }
            return
        }
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

    func showPairing() {
        path.append(.pairing)
    }

    func showHistory() async {
        path.append(.history)
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
        static let onDeviceEnabled = "onDeviceEnabled"
        static let keepTranscripts = "keepTranscripts"
    }

    private static func loadLastSession(from defaults: UserDefaults) -> LastSession? {
        guard let name = defaults.string(forKey: Keys.transcriptName) else { return nil }
        let ended = defaults.double(forKey: Keys.endedAt)
        guard ended > 0 else { return nil }
        return LastSession(transcriptName: name, endedAt: Date(timeIntervalSince1970: ended))
    }
}
