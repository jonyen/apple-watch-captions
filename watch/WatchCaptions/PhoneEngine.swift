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
/// place. No delegate is assigned here — that stays `PhoneEngine`'s job, the
/// only watch-side `WCSessionDelegate` now that `SpikeWC` is gone — so this
/// is safe to call before any `PhoneEngine` exists and a no-op afterwards.
enum WCActivation {
    static func activateIfNeeded() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        guard session.activationState != .activated else { return }
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
        guard session.activationState != .activated else { return }
        session.activate()
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

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}

    func session(_ session: WCSession, didReceiveMessageData messageData: Data) {
        guard let message = PhoneWire.decode(messageData) else { return }
        queue.async { [weak self] in self?.handle(message) }
    }

    /// Reachability going false ends the session exactly like an `error`
    /// frame or repeated send failures — the hybrid's `relayDied()` path
    /// handles all three identically.
    func sessionReachabilityDidChange(_ session: WCSession) {
        guard !session.isReachable else { return }
        queue.async { [weak self] in self?.fail() }
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
            // not queued. Wire captions carry no sessionId, so without this
            // gate a late frame from a session that has already closed (see
            // `close()`'s linger) could otherwise be mistaken for this one's
            // first caption before this one's `ready` lands. The remaining
            // cross-session window — a straggler arriving *after* this
            // session's own `ready` — needs a sessionId on the wire message
            // to close fully; deferred to Task 8, which reopens `PhoneWire`.
            guard readyDelivered else { return }
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
