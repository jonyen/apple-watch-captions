import Foundation
import WatchKit
import CaptionCore
import CaptionRelay

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
        /// Reading audio playing on the iPhone.
        case phone
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

    /// True while the call screen is up but no call has arrived yet. The
    /// screen is entered by choice, before anyone has dialled — without this
    /// the user faced a blank caption view whose indicator claimed a call was
    /// being captioned, with the talk gesture live and recording into a turn
    /// that could only end in a refusal.
    @Published private(set) var callWaiting = false
    /// True when the live call is one the watch holds: it can hear the
    /// caller, speak back, and hang up. False on the relay's fallback, which
    /// is captions only because the phone holds that call — so no talk
    /// gesture, no playback, and no Stop button that would lie about being
    /// able to end it.
    @Published private(set) var callTwoWay = false

    private let controller: SessionController
    private let relay: HTTPRelayClient
    private let micPermission = MicPermission()
    private let defaults: UserDefaults
    /// Waits for the relay to push a finished transcript to Notion.
    private let exports: ExportWatcher
    private let notifier = ExportNotifier()
    /// Reads a live phone call. Shares `store` with mic sessions — the two are
    /// never live at once.
    let callCaptions: CallCaptions
    private let callClient: RelayCallClient
    /// Push-to-talk state for the call on screen.
    let callVoice: CallVoice
    private let callAudio: CallAudio
    private let audioPlayer = CallAudioPlayer()
    private var callAudioTask: Task<Void, Never>?
    /// Identifies the push-to-talk turn currently open. `endTalking()` un-mutes
    /// after an `await`, and a release-then-press during that in-flight send
    /// would otherwise have turn 1's continuation un-mute turn 2's open
    /// microphone — the speaker resuming into a live mic, sending the caller
    /// back to themselves about four seconds late. Compared after the await.
    private var turnGeneration = 0
    /// True from the moment a hangup starts until the next call screen opens.
    /// See `endCall()`.
    private var endingCall = false
    /// True once this call's audio engine has been asked to start. See
    /// `callArrived(twoWay:)`.
    private var callAudioStarted = false
    /// Reads audio playing on the iPhone. Its own controller and transport,
    /// because it joins a session the phone owns rather than starting one — but
    /// it shares `store`, since only one thing is ever on screen.
    private let phoneController: SessionController
    /// Restores a resumed session's scrollback behind `controller`. Kept off
    /// `SessionController` itself so a fetch that outlives its session has
    /// somewhere to be guarded without the controller knowing history exists.
    private let prefiller: TranscriptPrefiller
    private let settingsClient: RelaySettingsClient
    /// What the phone last said. Defaults until the relay answers, so the app
    /// works unchanged when it cannot be reached.
    @Published private(set) var settings: Settings = .defaults
    /// True while the phone-audio screen is reading. Kept apart from
    /// `capturing`, which means a mic session and drives Stop, resume and the
    /// "Continue last" bookkeeping — none of which apply to reading a session
    /// this Watch does not own.
    @Published private(set) var readingPhone = false
    /// Whether the phone has fed the shared session recently.
    ///
    /// Drives two things: whether the menu offers iPhone audio at all, and
    /// whether that screen shows captions or the instructions for starting a
    /// broadcast. A row that is only useful while the phone is broadcasting has
    /// no business sitting on the menu the rest of the time — and with
    /// auto-open on, it is rarely seen at all.
    @Published private(set) var phoneBroadcasting = false
    /// Watches for the broadcast starting while the screen is open.
    private var phonePresencePoll: Task<Void, Never>?
    /// The foreground poll. Cancelled and replaced whenever a new wait starts.
    private var exportPoll: Task<Void, Never>?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
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
        let callClient = RelayCallClient(base: base, token: token)
        self.callClient = callClient
        callCaptions = CallCaptions(client: callClient, store: store)
        let audioClient = RelayCallAudioClient(base: base, token: token)
        let voice = CallVoice(client: audioClient)
        callVoice = voice
        let player = audioPlayer
        callAudio = CallAudio(client: audioClient) { [player] samples in player.play(samples) }
        // The mic runs for the whole call; CallVoice keeps only what falls
        // inside a push-to-talk turn and discards the rest, so the room never
        // reaches the caller.
        audioPlayer.onCapturedPCM = { [voice] pcm in
            Task { @MainActor in voice.capture(pcm) }
        }
        controller = SessionController(
            store: store,
            relay: relay,
            audio: AudioCapture(),
            permission: micPermission
        )
        // Resuming a session restores its transcript; this reads it. Kept off
        // HistoryStore, whose `detail` belongs to the history screen.
        prefiller = TranscriptPrefiller(history: historyClient)
        let phoneRelay = HTTPRelayClient(
            base: base, token: token,
            fixedSessionID: PhoneAudio.sessionID)
        phoneRelay.mode = .live
        phoneController = SessionController(
            store: store,
            relay: phoneRelay,
            audio: SilentCapture(),
            permission: NoMicNeeded())
        settingsClient = RelaySettingsClient(base: base, token: token)
        lastSession = Self.loadLastSession(from: defaults)
        stoppedExplicitly = defaults.bool(forKey: Keys.stoppedExplicitly)
        relay.onTranscript = { [weak self] name in self?.currentTranscript = name }
        // The wait ends when the relay says a call is live. Nothing before
        // that point should start audio or accept a talk gesture — there is
        // no call to send it to.
        callCaptions.onLive = { [weak self] twoWay in
            self?.callArrived(twoWay: twoWay)
        }
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

        // Settings first: they decide what the rest of this launch does.
        settings = await settingsClient.settings()

        // A call in progress is the most likely reason the app is being opened
        // at all, so it wins over the menu and over resuming a past session.
        if await enterCallIfLive() { return }

        // Then the phone: if it is broadcasting, reading it is almost certainly
        // why the app is being opened. Same shape as the call check, and off by
        // default is a setting rather than an argument.
        phoneBroadcasting = await phoneIsBroadcasting()
        if settings.autoOpenPhoneAudio, phoneBroadcasting {
            await startPhoneAudio()
            return
        }
        // Keep asking while the app is on screen, so starting the broadcast on
        // the phone makes the menu row appear without a trip out and back.
        watchForBroadcast()

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
    ///
    /// `ready: false`: this probe runs on every launch, whatever the user
    /// opened the app for, and presence must mean "the call screen is up and
    /// waiting" rather than "the app is running". The poll `callCaptions`
    /// starts a line later claims presence properly.
    ///
    /// The call is already live here, so this skips the waiting state and
    /// goes straight to the screen `callArrived` would have led to.
    private func enterCallIfLive() async -> Bool {
        guard let update = try? await callClient.poll(since: 0, ready: false),
              update.active else {
            return false
        }
        path = [.call]
        callWaiting = false
        callTwoWay = false
        endingCall = false
        callAudioStarted = false
        callCaptions.start()
        // `CallCaptions.onLive` will fire again on its first poll and land on
        // the same state; doing it here as well means the screen is right
        // from the first frame rather than a second later.
        callArrived(twoWay: update.twoWay)
        return true
    }

    /// A call has arrived (or was already in progress). Leaves the waiting
    /// state and, on a call the watch holds, starts hearing and speaking.
    ///
    /// A fallback call gets neither: the phone holds it, the relay's stream
    /// for it is one-way, and playing the caller aloud two seconds late would
    /// talk over the conversation the user is already having.
    private func callArrived(twoWay: Bool) {
        callWaiting = false
        // `startCallAudio` awaits the permission prompt before it has a task
        // to show for itself, so the flag is set here, synchronously — a
        // second arrival landing inside that await would otherwise start a
        // second engine on the same call. Both callers can announce the same
        // call: `enterCallIfLive` reports it directly so the screen is right
        // from the first frame, and `CallCaptions.onLive` reports it again a
        // poll later.
        guard twoWay, !callAudioStarted else { return }
        callAudioStarted = true
        Task { await startCallAudio() }
    }

    /// Leave call captions. Backing out ends the call exactly like tapping
    /// End: closing the stream is what ends it, so there is no way to stop
    /// reading a call and leave it live.
    func leaveCall() async {
        await endCall()
    }

    /// Wait for a call. Polling is what tells the relay the watch is here, so
    /// this both shows the waiting screen and makes the call reachable.
    ///
    /// Nothing starts yet. There is no call to hear or speak on until one
    /// arrives, which `callCaptions.onLive` reports.
    func takeCall() {
        path = [.call]
        callWaiting = true
        callTwoWay = false
        endingCall = false
        callAudioStarted = false
        callCaptions.start()
    }

    /// Start hearing and speaking on a call already known to be live.
    ///
    /// Permission first, as `SessionController` does for a mic session. The
    /// call path had no equivalent and swallowed the failure with `try?`,
    /// which failed silently in the worst possible way: `play()` returns
    /// forever on its `engine.isRunning` guard, the input tap is never
    /// installed, so no audio is ever captured, every turn ends up empty, and
    /// nothing is ever sent. The user holds the screen, sees the "Talking"
    /// badge, speaks — and the caller hears nothing, permanently, with the UI
    /// insisting otherwise.
    private func startCallAudio() async {
        guard await micPermission.ensureGranted() else {
            store.setError("Microphone access is off. Enable it in Settings › Privacy.")
            return
        }
        callAudio.reset()
        do {
            try audioPlayer.start()
        } catch {
            store.setError("Could not start audio.")
            return
        }
        callTwoWay = true
        callAudioTask?.cancel()
        callAudioTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.callAudio.poll()
                try? await Task.sleep(nanoseconds: 500_000_000)
            }
        }
    }

    /// Open a turn. Playback mutes for its duration: push-to-talk already
    /// means the speaker is idle while the mic is open, and muting discards
    /// whatever was still queued so a draining buffer cannot render into it.
    func beginTalking() {
        guard !callVoice.isTalking else { return }
        turnGeneration += 1
        audioPlayer.mute()
        callVoice.beginTalking()
    }

    /// Close the turn. The un-mute is gated on this still being the turn that
    /// opened it: releasing and pressing again while the send is in flight
    /// would otherwise let turn 1's continuation un-mute turn 2's open
    /// microphone, and the caller would hear themselves about four seconds
    /// late — the one thing push-to-talk exists to prevent.
    func endTalking() async {
        let generation = turnGeneration
        let refusal = await callVoice.endTalking()
        guard generation == turnGeneration else { return }
        audioPlayer.unmute()
        // Not a dropped packet: the relay refuses every turn from here on.
        // Better to say the call is over than to leave the user pressing and
        // speaking into it.
        if refusal == .noCallLive { store.setError("The audio has ended.") }
    }

    /// Leave the call, and end it.
    ///
    /// Closing the relay's Twilio stream is what ends it — under
    /// `<Connect><Stream>` the call lives for exactly as long as that socket,
    /// and the watch is not a party to it, so `POST /v1/call/end` is the only
    /// thing that can hang up. Everything below it is watch-local teardown;
    /// on its own that would return the watch to its menu and leave the
    /// caller connected to silence, billed, until they gave up.
    ///
    /// Failures are ignored deliberately. The user asked to leave; a relay
    /// that cannot be reached is not a reason to hold them on a screen they
    /// are done with, and the call dies with the stream either way.
    ///
    /// Force-closes any turn still open, first and unconditionally.
    /// `DragGesture` never gets its `.onEnded` when the view holding it
    /// leaves the hierarchy mid-press — which happens here whenever
    /// `store.state` swaps `CaptionView` for `ErrorView` while the caption
    /// area is held — so without this, `callVoice.isTalking` and
    /// `audioPlayer.isMuted` would stay stuck true and survive into the next
    /// call: it would open already "talking", play nothing from its first
    /// packet, and eventually send a stale blob accumulated since the
    /// original press. `callVoice.endTalking()` is a no-op when no turn is
    /// open, so calling it here unconditionally is safe.
    func endCall() async {
        // Dismissing the screen fires its `.onDisappear`, which calls
        // `leaveCall()`, which lands back here — so a hangup would otherwise
        // always run twice, with two overlapping requests racing each other.
        guard !endingCall else { return }
        endingCall = true
        turnGeneration += 1
        await callVoice.endTalking()
        audioPlayer.unmute()
        callAudioTask?.cancel()
        callAudioTask = nil
        audioPlayer.stop()
        callCaptions.stop()
        callWaiting = false
        callTwoWay = false
        callAudioStarted = false
        // Leave the screen before waiting on the network. Hanging up should
        // feel immediate; the relay is what the caller is waiting on, not the
        // user, and holding the call screen up for the round trip only makes
        // it look as though the tap did nothing.
        path = []
        try? await callClient.end()
    }

    /// Read whatever is playing on the iPhone. The phone's broadcast extension
    /// posts the audio; this only reads the captions back, so there is nothing
    /// here to start, stop or save on the relay.
    func startPhoneAudio() async {
        currentTranscript = nil
        readingPhone = true
        path = [.phone]
        watchForBroadcast()
        // `.live` on both sides: the phone marks the session ephemeral, so the
        // relay writes no transcript, runs no summary and exports nothing. A
        // podcast does not belong in the transcript list.
        await phoneController.start()
    }

    /// Stop reading the phone's audio. The phone keeps broadcasting — this is
    /// the same distinction as leaving call captions without hanging up.
    func leavePhoneAudio() {
        guard readingPhone else { return }
        readingPhone = false
        // The poll keeps running: back on the menu, the same answer decides
        // whether the row is there.
        phoneController.stop()
        path = []
    }

    /// Poll while the phone screen is open, so starting the broadcast on the
    /// phone replaces the instructions here without anything to tap. Three
    /// seconds is well inside the relay's ten-second presence window, and one
    /// small request costs far less than the captions it is waiting for.
    private func watchForBroadcast() {
        phonePresencePoll?.cancel()
        phonePresencePoll = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                let producing = await self.phoneIsBroadcasting()
                if self.phoneBroadcasting != producing { self.phoneBroadcasting = producing }
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }

    /// True when the phone has fed the shared session recently.
    private func phoneIsBroadcasting() async -> Bool {
        await settingsClient.presence(session: PhoneAudio.sessionID).producer
    }

    /// Start a mic session in whichever mode the settings ask for. With
    /// transcripts off, "New session" keeps nothing — the same promise the
    /// Live button makes, applied to the default.
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
        prefiller.cancel()
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
        prefiller.cancel()
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
}
