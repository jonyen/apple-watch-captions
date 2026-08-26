import Foundation
import WatchKit
import WatchConnectivity
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

    /// Drives the current Auto session. Rebuilt fresh at every Auto
    /// `startCaptions(mode:)` call (see `makeAutoController(mode:)`), rather
    /// than held for the app's lifetime like `onDeviceController`: Auto picks
    /// its remote transcriber per session, and both `SessionController` and
    /// `HybridEngine` bind to their engine for life at `init`, so a new
    /// choice of remote needs a new pair. `nil` whenever no Auto session has
    /// run yet.
    private var controller: SessionController?
    /// The relay origin every relay-facing client (`HTTPRelayClient`,
    /// `RelayHistoryClient`, the on-device uploaders) is built against.
    private let base: URL
    /// Resolves this device's bearer token — handed to every client that
    /// authorizes requests, including `PhoneEngine` and each session's
    /// `HTTPRelayClient`. See `HTTPRelayClient`'s doc comment for why this is
    /// a provider rather than a resolved `String`.
    private let token: @Sendable () async throws -> String
    /// One loaded Moonshine model, shared by every session's local leg —
    /// Auto's `HybridEngine` and `SavedOnDeviceEngine` alike — since only one
    /// session ever runs at a time. Each wrapper rebinds its callbacks in its
    /// own `start()`, taking ownership for that session.
    private let moonshine = OnDeviceEngine()
    private let micPermission = MicPermission()
    /// Whether the watch currently has a network path at all — Wi‑Fi or
    /// cellular. One of the two legs `start()`/`retry()` probe (the other is
    /// `WCSession.default.isReachable`) to decide Auto vs. the on-device
    /// fallback. Started once here, at `AppModel` construction, so it has
    /// already observed a path update by the time the user reaches Start.
    private let reachability = NetworkReachability()
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
    /// The foreground poll. Cancelled and replaced whenever a new wait starts.
    private var exportPoll: Task<Void, Never>?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        reachability.start()
        // Absent means on: saving is the default the app has always had, and
        // `bool(forKey:)` alone would silently read absence as off.
        keepTranscripts = defaults.object(forKey: Keys.keepTranscripts) == nil
            ? true : defaults.bool(forKey: Keys.keepTranscripts)
        base = RelayOrigin.http(from: Secrets.relayURL)
        // A provider, not a resolved `String`: `init` is synchronous and
        // constructs every relay client eagerly, but the token comes from
        // `DeviceIdentity`, whose `token()` is `async throws` (it may need to
        // register this device with the relay on first launch). Each client
        // now holds this closure and resolves it per request instead of a
        // stored secret — see `HTTPRelayClient`'s doc comment.
        token = { try await DeviceIdentity.shared.token() }
        let token = self.token   // local shadow: closures below capture it implicitly, not `self`
        let historyClient = RelayHistoryClient(base: base, token: token)
        history = HistoryStore(client: historyClient)
        exports = ExportWatcher(client: historyClient, defaults: defaults)
        onDeviceEngine = SavedOnDeviceEngine(
            engine: moonshine,
            makeUploader: { CaptionUploader(token: token) },
            makeAudioArchiveUploader: { sessionID in
                AudioArchiveUploader(sessionID: sessionID, token: token)
            })
        onDeviceController = SessionController(
            store: store,
            relay: onDeviceEngine,
            audio: AudioCapture(),
            permission: micPermission)
        // Resuming a session restores its transcript; this reads it. Kept off
        // HistoryStore, whose `detail` belongs to the history screen.
        prefiller = TranscriptPrefiller(history: historyClient)
        lastSession = Self.loadLastSession(from: defaults)
        stoppedExplicitly = defaults.bool(forKey: Keys.stoppedExplicitly)
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
    }

    // MARK: - Sessions

    /// True when tapping Start should ask about the previous session first:
    /// a remote path would be chosen — the only case that can continue a
    /// saved *relay* transcript; an on-device or unkept Start just starts —
    /// and the previous session ended less than ten minutes ago (the window
    /// the relay holds a transcript open, the same 600 s caption-core's
    /// `launchAction` reasons about) without being explicitly stopped. Stop
    /// is a decision, so a stopped session is never offered.
    var shouldOfferResume: Bool {
        guard preferRemote, keepTranscripts else { return false }
        guard !stoppedExplicitly, let last = lastSession else { return false }
        return Date().timeIntervalSince(last.endedAt) < Self.resumeWindow
    }

    /// Whether a session started right now could reach a remote transcriber
    /// at all: the phone over `WatchConnectivity`, or a network path to the
    /// iMac relay. `start()`/`retry()` share this probe — with neither, the
    /// watch has no way to reach anyone and falls back to the on-device
    /// path, which with Keep on still writes the transcript on-device and
    /// uploads it once connectivity returns (see `startOnDeviceSession(keep:)`).
    private var preferRemote: Bool {
        WCSession.default.isReachable || reachability.hasNetworkPath
    }

    /// Start a session. The watch picks the shape itself: with a remote
    /// reachable (the phone over `WatchConnectivity`, or any network path to
    /// the iMac relay), it takes today's Auto path — instant local partials
    /// refined by the best remote transcriber available, degrading to
    /// local-only mid-session on any remote failure (`HybridEngine`'s
    /// standing contract). With neither reachable, it falls back to the
    /// on-device path — Moonshine alone, kept and uploaded later if
    /// connectivity returns. `startNew()`/`startLive()` build a fresh
    /// `HybridEngine` per session (see `makeAutoController(mode:)`) so Auto
    /// can pick its remote transcriber each time instead of talking to one
    /// fixed relay client.
    func start() async {
        switch (preferRemote, keepTranscripts) {
        case (false, false): await startOnDevice()
        case (false, true): await startSavedOnDevice()
        case (true, true): await startNew()
        case (true, false): await startLive()
        }
    }

    /// How long a just-ended session stays offerable, matching the relay's
    /// resume window.
    private static let resumeWindow: TimeInterval = 600

    /// Start an Auto session that keeps a transcript. `keepTranscripts`
    /// already decided that this call happens at all (see `start()`), so
    /// unlike the pre-roaming build there is no second, phone-set toggle to
    /// re-check here.
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

    /// Restart after a connection error, re-probing the same way `start()`
    /// does — so a retry can move between Auto and the on-device fallback as
    /// conditions change; that is the point of retrying here, not just
    /// re-dialing whatever failed. `keepTranscripts` cannot have changed
    /// since the session started — the home screen (the only place it's
    /// set) isn't reachable while a session is on screen — so it is exactly
    /// what the failed session asked for, which is what keeps a live
    /// session from quietly starting to record: the `(preferRemote,
    /// keepTranscripts)` switch below can only move a failed session
    /// between the unkept shapes (`startLive`/`startOnDevice`) or between
    /// the kept ones (`startNew`/`startSavedOnDevice`), never across that
    /// line. A retry that lands back on Auto also re-probes its remote leg
    /// (see `makeAutoController(mode:)`) and may pick a different
    /// transcriber than the one that just failed — the phone may have come
    /// back reachable, or gone out of range in the iMac's favor, since the
    /// last attempt.
    func retry() async {
        await start()
    }

    /// Builds this Auto session's remote leg — the phone, when it's
    /// reachable over `WatchConnectivity`, else the iMac relay directly
    /// (today's pre-roaming behavior; `HybridEngine` handles the case of
    /// neither being reachable, degrading to local-only once the chosen
    /// remote fails to connect) — and wraps it with the shared on-device
    /// engine in a fresh `HybridEngine`/`SessionController` pair. A fresh
    /// pair every session, rather than swapping the remote inside one
    /// long-lived engine, is what lets Auto's probe genuinely pick a
    /// different transcriber each time, including on `retry()`: both
    /// `HybridEngine.remote` and `SessionController`'s own relay reference
    /// are bound for the life of the instance.
    ///
    /// `remote` is held here as its concrete type just long enough to set
    /// `.mode` and `.onTranscript` — properties outside the `CaptionEngine`
    /// protocol that `PhoneEngine` and `HTTPRelayClient` each declare the
    /// same way `AppModel` already relied on `HTTPRelayClient` declaring
    /// them. `HybridEngine` itself never sees the concrete type; it is handed
    /// the same `remote` value only through the `CaptionEngine` surface.
    private func makeAutoController(mode: SessionMode) -> SessionController {
        let remote: CaptionEngine & AnyObject
        if WCSession.default.isReachable {
            let phone = PhoneEngine(token: token)
            phone.mode = mode
            phone.onTranscript = { [weak self] name in self?.currentTranscript = name }
            remote = phone
        } else {
            let http = HTTPRelayClient(base: base, token: token)
            http.mode = mode
            http.onTranscript = { [weak self] name in self?.currentTranscript = name }
            remote = http
        }
        let engine = HybridEngine(local: moonshine, remote: remote)
        // The remote leg dying mid-session no longer ends it — captions
        // continue from the local engine — but a session that asked to be
        // kept is no longer being written down from that moment. Flip `live`
        // so the indicator turns hollow ("not saved") rather than keep
        // claiming a persistence the remote stopped providing.
        // `currentTranscript` stays: everything up to the drop *was* saved
        // (when the remote ever named one), and resuming that transcript
        // later is exactly the recovery Start should offer.
        engine.onRelayDown = { [weak self] in
            guard let self, self.capturing, !self.onDevice else { return }
            self.live = true
        }
        return SessionController(store: store, relay: engine, audio: AudioCapture(), permission: micPermission)
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
        let controller = makeAutoController(mode: mode)
        self.controller = controller
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
            controller?.stop()
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
        if onDevice {
            onDeviceController.stop()
        } else {
            controller?.stop()
        }
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
        static let keepTranscripts = "keepTranscripts"
        // "captureMode" and "onDeviceEnabled" named the old mode button's
        // choice (and, before that, the older "On device" toggle). Neither
        // is read anymore — the watch now picks automatically every
        // session (see `preferRemote`) — so a value persisted by an older
        // build simply sits unread rather than resurrecting either dead
        // enum: there is no code path left that would look it up.
    }

    private static func loadLastSession(from defaults: UserDefaults) -> LastSession? {
        guard let name = defaults.string(forKey: Keys.transcriptName) else { return nil }
        let ended = defaults.double(forKey: Keys.endedAt)
        guard ended > 0 else { return nil }
        return LastSession(transcriptName: name, endedAt: Date(timeIntervalSince1970: ended))
    }
}
