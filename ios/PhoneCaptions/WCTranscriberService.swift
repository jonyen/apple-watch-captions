import Foundation
import WatchConnectivity
import TranscriberCore
import CaptionRelay

/// Runs one `TranscriberSession` per watch capture, driven entirely over
/// `WatchConnectivity`. The watch owns the microphone and the UI; this is
/// just the phone-side leg that turns its raw PCM into captions and hands
/// them straight back.
///
/// At most one session is active at a time — the watch only ever runs one
/// capture — so a `begin` for a different session id tears down whatever is
/// running (newest wins) rather than trying to multiplex.
///
/// All mutable state is confined to `queue`; every `WCSessionDelegate`
/// callback (which WatchConnectivity delivers on its own private queue) hops
/// onto it before touching anything.
final class WCTranscriberService: NSObject, WCSessionDelegate, ObservableObject {
    static let shared = WCTranscriberService()

    /// What the status view shows. Not part of the watch-facing protocol —
    /// purely local bookkeeping for the phone's own UI.
    enum Status: Equatable {
        case waiting
        case transcribing
    }

    enum KeptEvent {
        case line(sessionId: String, token: String, caption: PhoneWire.Caption)
        case finished(sessionId: String, token: String)
    }

    /// Fired for kept sessions only (every final caption, then once on
    /// finish), on `queue` — never the main thread. Task 6's forwarding
    /// store subscribes to this.
    var onKeptSessionEvent: ((KeptEvent) -> Void)?

    @Published private(set) var status: Status = .waiting
    @Published private(set) var sessionsServed: Int = 0

    private let queue = DispatchQueue(label: "wctranscriber.service")
    private let locale = Locale(identifier: "en-US")

    /// Set once `TranscriberSession.ensureModel` has succeeded, so it only
    /// runs once per process rather than once per session.
    private var modelEnsured = false

    /// The session id a `begin` is currently starting up under. Compared
    /// against on the async init's return so a superseded begin (a newer one
    /// arrived before the old one finished initializing) drops its result
    /// instead of clobbering the session that replaced it.
    private var pendingSessionId: String?

    /// Session ids currently allowed to reach `send()` through `handleEvent`.
    /// A session is live from the moment `attach` hooks it up until either
    /// `teardown` displaces it or `handleFinish`'s drain fully completes —
    /// deliberately broader than `active` (which `handleFinish` clears
    /// immediately so a new `begin` isn't blocked on the old session's
    /// drain), so a torn-down session's already-in-flight events are dropped
    /// while a finishing session's are still delivered.
    private var liveSessionIds: Set<String> = []

    private struct ActiveSession {
        let sessionId: String
        let keep: Bool
        let token: String?
        let transcriber: TranscriberSession
        let pumpTask: Task<Void, Never>
    }

    private var active: ActiveSession?

    private override init() {
        super.init()
    }

    func activate() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    // MARK: - WCSessionDelegate

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}

    func sessionDidBecomeInactive(_ session: WCSession) {}

    func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }

    func session(_ session: WCSession, didReceiveMessageData messageData: Data) {
        guard let message = PhoneWire.decode(messageData) else { return }
        queue.async { [weak self] in
            self?.handle(message)
        }
    }

    // MARK: - Message handling (always on `queue`)

    private func handle(_ message: PhoneWire.Message) {
        switch message {
        case .begin(let begin):
            handleBegin(begin)
        case .audio(let audio):
            active?.transcriber.feed(audio.pcm)
        case .finish:
            handleFinish()
        case .shareIdentity:
            // Task 8: WatchIdentityStore lands then; for now the phone has
            // nowhere to put the watch's token, so this is decoded (not a
            // decode failure) and deliberately ignored.
            break
        case .ready, .caption, .error:
            // These are things this service sends, never receives.
            break
        }
    }

    private func handleBegin(_ begin: PhoneWire.Begin) {
        if let current = active {
            guard current.sessionId != begin.sessionId else { return }  // duplicate begin, ignore
            teardown(current)
            // Clear the window now, before the new session's async init even
            // starts, so `audio` arriving in the meantime is dropped (no
            // active session) rather than fed to the transcriber just torn
            // down.
            active = nil
        }

        pendingSessionId = begin.sessionId
        setStatus(.transcribing)

        let sessionId = begin.sessionId
        let keep = begin.keep
        let token = begin.token
        let locale = self.locale
        // Decided and applied here rather than inside the Task: `handleBegin`
        // itself already runs on `queue`, so this is the one safe place to
        // touch `modelEnsured` without a hop — and setting it synchronously,
        // before any `await`, is what stops a second `begin` arriving while
        // the first is still ensuring the model from calling `ensureModel`
        // again.
        let shouldEnsureModel = !modelEnsured
        if shouldEnsureModel { modelEnsured = true }

        Task { [weak self] in
            do {
                if shouldEnsureModel {
                    try await TranscriberSession.ensureModel(locale: locale)
                }
                let transcriber = try await TranscriberSession(locale: locale, format: .pcm16k)
                self?.queue.async {
                    self?.attach(transcriber, sessionId: sessionId, keep: keep, token: token)
                }
            } catch {
                self?.queue.async {
                    // This begin owned the ensure attempt and it (or the
                    // session construction gated behind it) failed — let a
                    // future begin retry rather than permanently believing
                    // the model is ready.
                    if shouldEnsureModel { self?.modelEnsured = false }
                    self?.send(.error("transcriber init failed: \(error.localizedDescription)"))
                    if self?.pendingSessionId == sessionId {
                        self?.pendingSessionId = nil
                        self?.setStatus(.waiting)
                    }
                }
            }
        }
    }

    /// Runs on `queue`. Finishes attaching a `TranscriberSession` that just
    /// finished initializing — unless a newer `begin` has already superseded
    /// it, in which case it is torn down unused.
    private func attach(_ transcriber: TranscriberSession, sessionId: String, keep: Bool, token: String?) {
        guard pendingSessionId == sessionId else { return }
        pendingSessionId = nil

        let pumpTask = Task { [weak self] in
            for await event in transcriber.events {
                // Checked every iteration rather than trusted to stop the
                // loop by itself: cancelling a `Task` never interrupts a
                // `for await` already suspended inside it — only this check,
                // on the next value the stream actually produces, does. See
                // `teardown` for what makes the stream produce one (or end).
                if Task.isCancelled { break }
                self?.queue.async {
                    self?.handleEvent(event, sessionId: sessionId, keep: keep, token: token)
                }
            }
        }
        liveSessionIds.insert(sessionId)
        active = ActiveSession(sessionId: sessionId, keep: keep, token: token,
                                transcriber: transcriber, pumpTask: pumpTask)
    }

    /// Runs on `queue`.
    private func handleEvent(_ event: TranscriberSession.Event, sessionId: String, keep: Bool, token: String?) {
        // Belt-and-suspenders against `pumpTask`'s cancellation check: an
        // event already pulled off the stream before cancellation was
        // observed can still reach here for a session that has since been
        // torn down (see `teardown`) or fully finished (see `handleFinish`).
        guard liveSessionIds.contains(sessionId) else { return }
        switch event {
        case .ready:
            send(.ready)
        case .transcript(let text, let isFinal):
            send(.caption(PhoneWire.Caption(text: text, isFinal: isFinal)))
            if isFinal, keep, let token {
                onKeptSessionEvent?(.line(sessionId: sessionId, token: token,
                                          caption: PhoneWire.Caption(text: text, isFinal: isFinal)))
            }
        case .error(let message):
            send(.error(message))
        }
    }

    private func handleFinish() {
        guard let current = active else { return }
        active = nil
        pendingSessionId = nil

        Task { [weak self] in
            await current.transcriber.finish()
            // `finish()` only returns once the analyzer has drained (or timed
            // out), but the pump task's `for await` loop is what actually
            // delivers the last final through `handleEvent` — wait for it too
            // so `.finished` never races ahead of that last line.
            _ = await current.pumpTask.value
            self?.queue.async {
                // Only now — after the drain the two awaits above waited
                // for — does this session stop being "live"; `handleEvent`
                // needs it live for exactly as long as the pump can still be
                // delivering its last final.
                self?.liveSessionIds.remove(current.sessionId)
                if current.keep, let token = current.token {
                    self?.onKeptSessionEvent?(.finished(sessionId: current.sessionId, token: token))
                }
                self?.incrementSessionsServed()
                self?.setStatus(.waiting)
            }
        }
    }

    /// Displaces a session a newer `begin` has superseded. Cancelling
    /// `pumpTask` alone would not stop it — a `for await` already suspended
    /// inside a cancelled `Task` keeps waiting on whatever the sequence
    /// produces next, so without more the old `TranscriberSession` would run
    /// (and keep being retained by that loop) forever. Calling `finish()`
    /// unwinds its internal tasks and completes `events`, which is what
    /// actually lets the `for await` end — the cancellation check inside it
    /// then stops it from acting on anything `finish()` still flushes out
    /// first, and `liveSessionIds` (checked in `handleEvent`) is the backstop
    /// for the one event that may already be in flight when this runs.
    private func teardown(_ session: ActiveSession) {
        session.pumpTask.cancel()
        liveSessionIds.remove(session.sessionId)
        let transcriber = session.transcriber
        Task {
            await transcriber.finish()
        }
    }

    private func send(_ message: PhoneWire.Message) {
        guard WCSession.isSupported(), WCSession.default.activationState == .activated else { return }
        WCSession.default.sendMessageData(PhoneWire.encode(message), replyHandler: nil, errorHandler: nil)
    }

    // MARK: - Published state

    /// `@Published` writes have to land on the main thread for SwiftUI to
    /// observe them correctly; every other method here runs on `queue`.
    private func setStatus(_ status: Status) {
        DispatchQueue.main.async { [weak self] in self?.status = status }
    }

    private func incrementSessionsServed() {
        DispatchQueue.main.async { [weak self] in self?.sessionsServed += 1 }
    }
}
