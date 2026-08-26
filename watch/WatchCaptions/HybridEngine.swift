import Foundation
import os
import CaptionCore

/// Speculative captioning: a relay session with the local Moonshine engine
/// running alongside it, so captions appear the instant speech does instead
/// of a network round-trip later. Both engines hear every audio chunk; what
/// reaches the screen is arbitrated here.
///
/// The contract, in one paragraph: LOCAL text is always provisional — while
/// the relay is alive, no local line is ever emitted as final. Local segment
/// finals accumulate into one growing partial (finals joined with spaces,
/// plus the current partial tail) that repaints as speech continues. RELAY
/// finals are authoritative: each one is emitted as the real final and resets
/// the local accumulation, so the higher-quality text replaces the
/// speculative text paragraph by paragraph. Relay partials are ignored while
/// the local engine is producing text — local is faster, and two partial
/// streams fighting over one line reads as flicker. If the RELAY dies, the
/// session does not: whatever local text the relay never superseded is
/// emitted as a final at the transition (nothing on screen is lost), and from
/// then on local events pass through verbatim — local finals become real
/// finals. If the LOCAL engine dies while the relay is alive, relay events
/// pass through verbatim instead (slower captions beat none). Only when both
/// are gone does the session end.
///
/// Boundary fuzz is accepted v1 behavior: a relay final and the local
/// accumulation it resets cover *roughly* the same speech, not exactly — the
/// two engines segment independently. Local text spoken after the speech the
/// relay final covers is dropped from the screen until the local engine's
/// next event repaints it, and conversely a slightly stale accumulated tail
/// can ride along one paint too long. The window is one partial repaint
/// (sub-second); doing better means aligning the two transcripts by content,
/// which is not v1.
///
/// The local `OnDeviceEngine` is the same instance `SavedOnDeviceEngine`
/// wraps — one loaded model serves both, since only one session runs at a
/// time. Each wrapper therefore (re)binds the engine's callbacks in its own
/// `start()`, taking ownership for that session.
///
/// Threading: every callback in `CaptionEngine` is a `@MainActor` closure,
/// and `SessionController` calls `start()`/`close()` from the main actor, so
/// all arbitration state below is main-actor-confined — no lock needed. The
/// one exception is `send(_:)`, called on the audio thread; the only state it
/// reads is `relayFeedable`, which gets its own lock (feeding a dead relay
/// client would grow its pending buffer for the rest of the session).
final class HybridEngine: CaptionEngine {
    var onEvent: (@MainActor (CaptionEvent) -> Void)?
    var onClose: (@MainActor () -> Void)?
    /// Fires when the relay dies mid-session while local captions continue —
    /// the moment a session that asked to be kept degrades to unsaved. UI
    /// bookkeeping only; the session itself keeps going.
    var onRelayDown: (@MainActor () -> Void)?

    private let local: OnDeviceEngine
    private let relay: HTTPRelayClient
    private let log = Logger(subsystem: "com.jonyen.watchcaptions", category: "HybridEngine")

    /// Whether the next session runs the local Moonshine engine at all, or
    /// leaves the relay to drive the session by itself — the app's Cloud
    /// mode. Set before `start()`; read once per connect, like
    /// `HTTPRelayClient.mode` and `SavedOnDeviceEngine.keep`. Living here
    /// rather than behind a second `HTTPRelayClient` (and a second
    /// controller wired to it) is the smaller change: `relay` already has
    /// exactly one owner, and giving it a second would need the same
    /// rebind-per-start dance `local` already requires for its two owners
    /// (`HybridEngine` and `SavedOnDeviceEngine`). With this off, every
    /// `guard localAlive else { onEvent?(event) }` branch below — written for
    /// "local already died mid-session" — passes relay events straight
    /// through from the start, which is exactly Cloud's contract: no
    /// speculative text, no degrade path, relay failure ends the session
    /// (the same as before `HybridEngine` existed).
    var localEnabled = true
    /// This session's `localEnabled`, latched at `start()` so a mutation
    /// mid-session (there's no UI for that today, but `close()` must still
    /// match what `start()` did) can't split the two.
    private var sessionUsesLocal = true

    /// No relay final for this long while local text keeps accumulating means
    /// the relay is wedged — connected, but never superseding anything (a
    /// stuck-but-alive Apple recognizer is a documented failure mode on this
    /// stack). Left to run, the accumulation grows without bound: an
    /// ever-longer partial re-joined and repainted on every local event.
    /// Treated exactly like relay death: flush, degrade, carry on local-only.
    /// The watchdog ticks at a quarter of this, so the real trip point is
    /// 100–125 s.
    static let relayFinalTimeout: TimeInterval = 100

    /// Belt-and-braces alongside the watchdog: if the joined accumulation
    /// ever exceeds this many characters before the timeout trips (someone
    /// talking very fast at a wedged relay), degrade immediately rather than
    /// keep growing the repaint. Roughly ten minutes of speech — far past
    /// anything a healthy relay leaves unsuperseded.
    static let maxSpeculativeCharacters = 4000

    // MARK: - Arbitration state (main-actor-confined)

    private var relayAlive = true
    private var localAlive = true
    private var readyDelivered = false
    /// Local segment finals since the last relay final (or relay-death flush).
    private var localFinals: [String] = []
    /// The local engine's current in-progress segment.
    private var localPartial = ""
    /// When the relay last made final progress — reset at start, on every
    /// relay final, and while there is no local accumulation pending (silence
    /// owes the relay nothing; the clock only runs against text it should be
    /// superseding).
    private var lastRelayFinalAt = Date()
    /// Fires on the main queue; lives from `start()` to `close()`/relay
    /// death, and never beyond — `relayDied()` and `close()` both cancel it,
    /// so it cannot fire into a finished session (the `relayAlive` guard
    /// would catch a straggler regardless, but the timer's lifetime should
    /// not lean on that).
    private var watchdog: DispatchSourceTimer?

    /// Whether `send(_:)` still fans audio to the relay. Off the main actor —
    /// see the threading note above.
    private let feedLock = NSLock()
    private var relayFeedable = true

    init(local: OnDeviceEngine, relay: HTTPRelayClient) {
        self.local = local
        self.relay = relay
        relay.onEvent = { [weak self] event in self?.handleRelay(event) }
        relay.onClose = { [weak self] in self?.handleRelayClose() }
    }

    /// Starts both engines. The local engine reports `.ready` instantly —
    /// before its models load, before the relay's first POST lands — so the
    /// session begins captioning even if the relay never connects.
    func start() {
        MainActor.assumeIsolated {
            sessionUsesLocal = localEnabled
            relayAlive = true
            localAlive = sessionUsesLocal
            readyDelivered = false
            localFinals = []
            localPartial = ""
            feedLock.lock(); relayFeedable = true; feedLock.unlock()
            if sessionUsesLocal {
                // Take the shared Moonshine engine over for this session (see
                // the type comment; `SavedOnDeviceEngine.start()` does the
                // same).
                local.onEvent = { [weak self] event in self?.handleLocal(event) }
                local.onClose = { [weak self] in self?.handleLocalDeath() }
            }
            lastRelayFinalAt = Date()
            startWatchdog()
            if sessionUsesLocal { local.start() }
            relay.start()
        }
    }

    /// Called on the audio thread: fan the chunk to both engines, or just the
    /// relay in Cloud mode.
    func send(_ audio: Data) {
        if sessionUsesLocal { local.send(audio) }
        feedLock.lock(); let feed = relayFeedable; feedLock.unlock()
        if feed { relay.send(audio) }
    }

    /// Local first — dropping its open segment is its documented close
    /// behavior — then the relay's close, whose best-effort `/v1/stop` lets
    /// the relay finalize the transcript. A relay final still in flight at
    /// that moment lands in the *saved* transcript on the relay (its stop
    /// path awaits the provider's graceful close) but no longer reaches this
    /// screen: the last paragraph shown may stay the speculative local text.
    func close() {
        MainActor.assumeIsolated {
            watchdog?.cancel()
            watchdog = nil
            feedLock.lock(); relayFeedable = false; feedLock.unlock()
            if sessionUsesLocal { local.close() }
            relay.close()
        }
    }

    // MARK: - Local events

    @MainActor
    private func handleLocal(_ event: CaptionEvent) {
        guard localAlive else { return }
        switch event {
        case .ready:
            deliverReadyIfNeeded()
        case .caption(let text, let isFinal, _):
            guard relayAlive else {
                // The relay is gone; local is the engine now. Its finals are
                // real finals — this is what keeps captions alive without
                // the relay.
                onEvent?(event)
                return
            }
            // Provisional: fold into the growing accumulation and repaint it
            // as one partial. Never final while the relay lives.
            if isFinal {
                if !text.isEmpty { localFinals.append(text) }
                localPartial = ""
            } else {
                localPartial = text
            }
            let cumulative = cumulativeText()
            guard cumulative.count <= Self.maxSpeculativeCharacters else {
                // The relay has left an implausible amount of text
                // unsuperseded; don't wait for the watchdog's next tick.
                log.error("speculative accumulation exceeded \(Self.maxSpeculativeCharacters) characters; degrading to on-device")
                relayDied()   // flushes this same accumulation as a final
                return
            }
            if !cumulative.isEmpty {
                onEvent?(.caption(text: cumulative, isFinal: false, channel: nil))
            }
        case .error(let message):
            localAlive = false
            if relayAlive {
                // Degraded mode: relay events pass through verbatim from here
                // on (see `handleRelay`); the session survives.
                log.error("local engine failed (\(message, privacy: .public)); continuing on relay alone")
            } else {
                onEvent?(event)   // both engines gone: a real session error
            }
        }
    }

    /// `OnDeviceEngine` never actually fires `onClose` today; bound anyway so
    /// a future change there degrades this session instead of stranding it.
    @MainActor
    private func handleLocalDeath() {
        guard localAlive else { return }
        localAlive = false
        if !relayAlive { onClose?() }
    }

    // MARK: - Relay events

    @MainActor
    private func handleRelay(_ event: CaptionEvent) {
        guard relayAlive else { return }
        switch event {
        case .ready:
            // Normally the local engine's instant ready won this; this path
            // only matters if the local engine could not report at all.
            deliverReadyIfNeeded()
        case .caption(let text, let isFinal, let channel):
            guard localAlive else {
                onEvent?(event)   // degraded mode: relay verbatim
                return
            }
            // Relay partials are ignored while local partials are flowing.
            guard isFinal else { return }
            // An empty final would clear the speculative partial while
            // appending nothing — dropping local text for no replacement.
            guard !text.isEmpty else { return }
            // Authoritative: emit as the real final and reset the local
            // accumulation. The local partial tail restarts from the next
            // local event (boundary fuzz — see the type comment).
            lastRelayFinalAt = Date()
            localFinals = []
            localPartial = ""
            onEvent?(.caption(text: text, isFinal: isFinal, channel: channel))
        case .error(let message):
            if localAlive {
                // A relay-reported error (provider down, ephemeral mismatch)
                // must not end a session the local engine is still
                // captioning. Stop feeding the relay and carry on local-only.
                log.error("relay error (\(message, privacy: .public)); continuing on-device")
                relayDied()
            } else {
                onEvent?(event)   // both gone
            }
        }
    }

    @MainActor
    private func handleRelayClose() {
        guard relayAlive else { return }
        if localAlive {
            log.error("relay connection lost; continuing on-device")
            relayDied()
        } else {
            onClose?()   // both gone: let the controller end the session
        }
    }

    /// The relay-death transition. Local text accumulated up to now never got
    /// a relay final to supersede it, so emit it as a final at the boundary —
    /// nothing on screen is lost — then let local events pass through
    /// verbatim (their finals are real from here on).
    @MainActor
    private func relayDied() {
        guard relayAlive else { return }
        relayAlive = false
        watchdog?.cancel()
        watchdog = nil
        feedLock.lock(); relayFeedable = false; feedLock.unlock()
        // Best-effort: tells the relay to finalize whatever it received. A
        // no-op if the client already tore itself down.
        relay.close()
        let flush = cumulativeText()
        localFinals = []
        localPartial = ""
        if !flush.isEmpty {
            onEvent?(.caption(text: flush, isFinal: true, channel: nil))
        }
        onRelayDown?()
    }

    // MARK: - Relay-finals watchdog

    @MainActor
    private func startWatchdog() {
        watchdog?.cancel()
        let interval = Self.relayFinalTimeout / 4
        let t = DispatchSource.makeTimerSource(queue: .main)
        t.schedule(deadline: .now() + interval, repeating: interval)
        t.setEventHandler { [weak self] in
            MainActor.assumeIsolated { self?.checkRelayProgress() }
        }
        t.resume()
        watchdog = t
    }

    @MainActor
    private func checkRelayProgress() {
        guard relayAlive, localAlive else { return }
        // Nothing pending means the relay owes nothing: silence, degraded
        // local, or a relay final that just cleared the slate. Keep the
        // clock parked at "now" so it only ever measures time the relay
        // spends behind text it should be superseding.
        guard !cumulativeText().isEmpty else {
            lastRelayFinalAt = Date()
            return
        }
        guard Date().timeIntervalSince(lastRelayFinalAt) > Self.relayFinalTimeout else { return }
        log.error("no relay final for \(Int(Self.relayFinalTimeout))s with local text accumulating; treating the relay as wedged and degrading to on-device")
        relayDied()
    }

    // MARK: - Helpers

    @MainActor
    private func cumulativeText() -> String {
        var parts = localFinals
        if !localPartial.isEmpty { parts.append(localPartial) }
        return parts.joined(separator: " ")
    }

    @MainActor
    private func deliverReadyIfNeeded() {
        guard !readyDelivered else { return }
        readyDelivered = true
        onEvent?(.ready)
    }
}
