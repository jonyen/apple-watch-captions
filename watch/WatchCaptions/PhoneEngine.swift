import Foundation
import WatchConnectivity
import CaptionCore
import CaptionRelay

/// Activates `WCSession` early — before any session actually starts — so
/// `AppModel`'s Auto-mode probe (`WCSession.default.isReachable`) reflects
/// reality by the time the user taps Start. Reachability means nothing on an
/// unactivated session (it reads `false`), and `PhoneEngine.start()` only
/// activates once a session is already under way, which would be too late
/// for the probe that decides whether to *use* `PhoneEngine` in the first
/// place.
///
/// `WCSession.activate()` silently never completes without a delegate set
/// beforehand — `activationState` sticks at `.notActivated`, `isReachable`
/// reads `false` forever, and the Auto probe would never pick `PhoneEngine`.
/// So this assigns a minimal placeholder delegate first, but only when no
/// delegate is set yet: it must never clobber a live `PhoneEngine`, which
/// remains the only *real* watch-side `WCSessionDelegate` (the only one that
/// actually receives audio/caption traffic) now that `SpikeWC` is gone.
/// `PhoneEngine.start()`'s own `delegate = self` swap-after-activation is
/// unaffected — it simply replaces this placeholder the first time a session
/// actually runs.
enum WCActivation {
    /// Satisfies `WCSessionDelegate` with a no-op so `activate()` can
    /// complete before any `PhoneEngine` exists to be the real delegate.
    /// Retained for the process lifetime (`WCSession.default.delegate` does
    /// not retain its delegate) via the static `placeholder` below.
    private final class Placeholder: NSObject, WCSessionDelegate {
        func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}
    }

    private static let placeholder = Placeholder()

    static func activateIfNeeded() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        guard session.activationState != .activated else { return }
        if session.delegate == nil {
            session.delegate = placeholder
        }
        session.activate()
    }
}

/// `CaptionEngine` over `WatchConnectivity`: streams PCM to the paired
/// iPhone's `WCTranscriberService` and receives caption events back over the
/// same channel. Auto mode's preferred remote leg — Bluetooth-only, so it
/// keeps working with no Wi-Fi and no cellular, unlike `HTTPRelayClient`.
///
/// PhoneEngine is only ever the remote leg inside `HybridEngine`: the local
/// Moonshine leg already delivers an instant `.ready`, so unlike
/// `HTTPRelayClient` (which must synthesize one when it runs alone) this
/// class emits nothing until the phone's own `ready` message arrives — proof
/// `WCTranscriberService` actually has a `TranscriberSession` receiving
/// `.audio`, not a guess.
///
/// Threading: `WCSessionDelegate` callbacks land on WatchConnectivity's own
/// queue; all mutable state here is confined to `queue`, the same discipline
/// `HTTPRelayClient` uses for its network callbacks.
final class PhoneEngine: NSObject, CaptionEngine, WCSessionDelegate {
    var onEvent: (@MainActor (CaptionEvent) -> Void)?
    var onClose: (@MainActor () -> Void)?
    /// Never fires today. A phone-transcribed session's transcript name, if
    /// it ever gets one, arrives asynchronously — once the phone's
    /// `ForwardingStore` has delivered the kept lines and the relay has
    /// replied with a name — well after this engine's session has ended, and
    /// over a channel this class does not see. History attribution for
    /// phone-transcribed kept sessions belongs to the forwarding work
    /// (Task 6+), not this engine. Kept here anyway so `PhoneEngine` reads as
    /// a drop-in `HTTPRelayClient` sibling wherever a call site wires the two
    /// engines' `onTranscript` the same way.
    var onTranscript: (@MainActor (String) -> Void)?

    /// What the next session asks the phone to do with what it hears — the
    /// same contract as `HTTPRelayClient.mode`: set before `start()`, read
    /// once per connect.
    var mode: SessionMode = .saved(resuming: nil)

    /// Resolves this device's bearer token — the same provider closure every
    /// other relay-facing client in `AppModel` is handed. Only consulted when
    /// `mode` is `.saved`: a live session names no token because the phone
    /// has nothing to keep.
    private let token: @Sendable () async throws -> String
    private let queue = DispatchQueue(label: "phoneengine.wc")

    private var sessionId = UUID().uuidString
    private var seq: Int64 = 0
    /// Set the moment this process has attempted (not necessarily
    /// succeeded) to share the watch's identity with the phone — a process-
    /// lifetime flag, not per-instance, since a fresh `PhoneEngine` is built
    /// for every Auto session (see AppModel.makeAutoController). Guards
    /// `shareIdentityIfNeeded()` so at most one `shareIdentity` send is
    /// attempted per app launch; a failed attempt is silent and simply
    /// leaves the phone unlinked until the next launch retries.
    private static var identityShareAttempted = false
    private var readyDelivered = false
    /// Guards against duplicate `onClose` firing and against sending after
    /// either a deliberate `close()` or a hard failure — set exactly once per
    /// session, by whichever of `close()`/`fail()` runs first.
    private var stopped = false
    private var consecutiveSendFailures = 0
    /// A send failure this many times in a row (with no successful message
    /// received from the phone in between — see `handle(_:)`) is treated as
    /// remote death, same as an `error` frame or reachability loss.
    private static let maxConsecutiveSendFailures = 3
    /// Retains `self` for the tail of `close()`: once `HybridEngine` drops
    /// its reference to the outgoing remote leg, nothing else would keep this
    /// instance — and its `WCSessionDelegate` registration — alive long
    /// enough to receive the phone's last final.
    private var closingSelf: PhoneEngine?
    private static let closeLinger: TimeInterval = 5

    init(token: @escaping @Sendable () async throws -> String) {
        self.token = token
        super.init()
    }

    func start() {
        let mode = self.mode
        queue.async { [weak self] in
            guard let self else { return }
            self.stopped = false
            self.sessionId = UUID().uuidString
            self.seq = 0
            self.readyDelivered = false
            self.consecutiveSendFailures = 0
            self.closingSelf = nil
            self.activateIfNeeded()
            self.beginSession(mode: mode)
        }
    }

    /// `WCSession.default.activate()` is idempotent, but calling it here
    /// (rather than relying solely on `WCActivation`) means `PhoneEngine`
    /// works correctly even standing alone — the probe that constructs it is
    /// just an optimization, not a requirement. Assigning `self` as delegate
    /// every `start()` is what makes `PhoneEngine` the one owner of
    /// `WCSession.default.delegate` on the watch: whichever instance last
    /// started a session receives its callbacks, which is exactly the one
    /// session the watch ever runs at a time.
    private func activateIfNeeded() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        shareIdentityIfNeeded(session: session)
        guard session.activationState != .activated else { return }
        session.activate()
    }

    /// Opportunistic, at most once per app launch: the watch's own bearer
    /// token, so the phone can browse this watch's transcripts. Fired here
    /// (every `start()`, i.e. every session) and from the reachability/
    /// activation delegate callbacks below, since whichever of those first
    /// observes a reachable counterpart should be the one that sends it —
    /// there is no dedicated "on activation" hook that fires before any
    /// session ever starts on the watch side (see `WCActivation`, which
    /// activates with no delegate at all). Marks the attempt made *before*
    /// the token fetch even starts, so a failure never retries within the
    /// same launch — "silent failure, next launch retries" per the design.
    private func shareIdentityIfNeeded(session: WCSession) {
        guard session.isReachable else { return }
        queue.async { [weak self] in
            guard let self, !Self.identityShareAttempted else { return }
            Self.identityShareAttempted = true
            let token = self.token
            Task { [weak self] in
                guard let bearer = try? await token() else { return }
                self?.queue.async {
                    self?.sendMessage(.shareIdentity(token: bearer))
                }
            }
        }
    }

    /// Mirrors `HTTPRelayClient.flush()`'s async token dance: `start()` is
    /// synchronous, but a `.saved` session needs a bearer token that can only
    /// be resolved with an `await`. Re-entering `queue` afterwards and
    /// re-checking `sessionId` guards against a `start()` that came and went
    /// (a fast retry) while the token was in flight.
    private func beginSession(mode: SessionMode) {
        let sessionId = self.sessionId
        switch mode {
        case .saved:
            let token = self.token
            Task { [weak self] in
                let bearer = try? await token()
                self?.queue.async {
                    guard let self, !self.stopped, self.sessionId == sessionId else { return }
                    guard let bearer else {
                        // No token, nothing to keep — the same hard stop
                        // `HTTPRelayClient.flush()` takes when its provider
                        // throws.
                        self.fail()
                        return
                    }
                    self.sendMessage(.begin(.init(sessionId: sessionId, keep: true, token: bearer)))
                }
            }
        case .live:
            queue.async { [weak self] in
                guard let self, !self.stopped, self.sessionId == sessionId else { return }
                self.sendMessage(.begin(.init(sessionId: sessionId, keep: false, token: nil)))
            }
        }
    }

    /// Called on the audio thread (see `HybridEngine`'s threading note).
    /// Audio is never queued: while the phone is unreachable a chunk is
    /// simply dropped, since live captioning wants freshness far more than
    /// completeness — the design's standing rule for this channel.
    func send(_ audio: Data) {
        queue.async { [weak self] in
            guard let self, !self.stopped else { return }
            guard WCSession.isSupported(), WCSession.default.isReachable else { return }
            let seq = self.seq
            self.seq += 1
            self.sendMessage(.audio(.init(seq: Int(seq), pcm: audio)))
        }
    }

    /// Tells the phone to drain its last final, then keeps this instance
    /// alive briefly so that final can still reach `handle(_:)` even after
    /// `HybridEngine` has dropped its own reference.
    func close() {
        queue.async { [weak self] in
            guard let self, !self.stopped else { return }
            self.stopped = true
            self.sendMessage(.finish)
            self.closingSelf = self
            self.queue.asyncAfter(deadline: .now() + Self.closeLinger) { [weak self] in
                self?.closingSelf = nil
            }
        }
    }

    // MARK: - WCSessionDelegate

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        guard activationState == .activated else { return }
        shareIdentityIfNeeded(session: session)
    }

    func session(_ session: WCSession, didReceiveMessageData messageData: Data) {
        guard let message = PhoneWire.decode(messageData) else { return }
        queue.async { [weak self] in self?.handle(message) }
    }

    /// Reachability going false ends the session exactly like an `error`
    /// frame or repeated send failures — the hybrid's `relayDied()` path
    /// handles all three identically.
    func sessionReachabilityDidChange(_ session: WCSession) {
        guard session.isReachable else {
            queue.async { [weak self] in self?.fail() }
            return
        }
        shareIdentityIfNeeded(session: session)
    }

    // MARK: - Internals (all on `queue`)

    /// Deliberately not guarded on `stopped`: a `close()` in flight starts
    /// the linger window precisely so a caption or the phone's drained final
    /// can still arrive and be emitted here.
    private func handle(_ message: PhoneWire.Message) {
        switch message {
        case .ready:
            consecutiveSendFailures = 0
            deliverReadyIfNeeded()
        case .caption(let caption):
            // A successful receive is proof the channel is alive, so this
            // still resets the failure count even when the caption itself is
            // dropped below.
            consecutiveSendFailures = 0
            // Never synthesize readiness from a caption, and never emit one
            // before the phone's own `ready` has actually arrived — dropped,
            // not queued. This closes the pre-ready half of the cross-session
            // bleed window: a late frame from a session that has already
            // closed (see `close()`'s linger) can no longer be mistaken for
            // this one's first caption before this one's `ready` lands.
            guard readyDelivered else { return }
            // The remaining, post-ready half of that window: a straggler
            // draining out of the OLD session (see WCTranscriberService's
            // `handleFinish`) can still arrive after this session is already
            // receiving. `sessionId` is now stamped on every caption the
            // phone sends (Task 8 wire amendment) — a caption whose
            // sessionId names a different session than this instance's own
            // is unambiguously stale and dropped here, which is the
            // authoritative guard: an older, un-labeled caption (sessionId
            // == nil) still passes through, but nothing after this task ever
            // sends one of those.
            if let captionSessionId = caption.sessionId, captionSessionId != sessionId { return }
            emit(.caption(text: caption.text, isFinal: caption.isFinal, channel: nil))
        case .error(let message):
            consecutiveSendFailures = 0
            emit(.error(message: message))
            fail()
        case .begin, .audio, .finish, .shareIdentity:
            break   // this engine only ever sends these, never receives them
        }
    }

    private func sendMessage(_ message: PhoneWire.Message) {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        guard session.activationState == .activated else { return }
        session.sendMessageData(PhoneWire.encode(message), replyHandler: nil) { [weak self] _ in
            self?.queue.async { self?.registerSendFailure() }
        }
    }

    private func registerSendFailure() {
        guard !stopped else { return }
        consecutiveSendFailures += 1
        guard consecutiveSendFailures >= Self.maxConsecutiveSendFailures else { return }
        fail()
    }

    private func deliverReadyIfNeeded() {
        guard !readyDelivered else { return }
        readyDelivered = true
        emit(.ready)
    }

    private func emit(_ event: CaptionEvent) {
        if let onEvent { Task { @MainActor in onEvent(event) } }
    }

    /// The one path that ends a session from the inside: a phone-reported
    /// `error`, reachability loss, or repeated send failures. `close()`
    /// (deliberate, app-driven) never calls this, so `onClose` never fires
    /// for a session the app itself ended.
    private func fail() {
        guard !stopped else { return }
        stopped = true
        if let onClose { Task { @MainActor in onClose() } }
    }
}
