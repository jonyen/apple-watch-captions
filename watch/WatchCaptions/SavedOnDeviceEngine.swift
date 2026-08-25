import Foundation
import CaptionCore

/// The on-device engine, with the transcript kept: a `OnDeviceEngine` does
/// the captioning exactly as in an unkept session, and every final line it
/// produces is also posted to the relay through a `CaptionUploader`, so the
/// session ends up stored — and summarized and exported — like any saved
/// relay session.
///
/// Composition, not a mode inside `OnDeviceEngine`: this type owns the
/// engine plus, per kept session, an uploader, and adds nothing beyond the
/// forwarding. `keep` follows `HTTPRelayClient.mode`'s lifecycle — set before
/// `start()`, read once per connect — so one instance (and one loaded model)
/// serves both kept and unkept sessions. Finals only go up: partials repaint
/// several times a second and the relay stores lines, not repaints.
///
/// The uploader can never fail the session — see `CaptionUploader` — so
/// `onEvent`/`onClose` are Moonshine's alone; the uploader reports only
/// through `onKept`, which drives the captions screen's saved/not-saved
/// indicator, and `onTranscript`, which names the relay transcript so the
/// app can offer to resume it later.
///
/// Not `Sendable` and needs no lock: `start()`/`close()` run on the main
/// actor (`SessionController` is `@MainActor`) and the engine tap below is a
/// `@MainActor` closure, so `uploader` is main-actor-confined; `send(_:)`,
/// the one call off it, touches only the engine, which is thread-safe.
final class SavedOnDeviceEngine: CaptionEngine {
    var onEvent: (@MainActor (CaptionEvent) -> Void)?
    var onClose: (@MainActor () -> Void)?
    /// Fires with whether this session's lines are reaching the relay. See
    /// `CaptionUploader.onKept`.
    var onKept: (@MainActor (Bool) -> Void)?
    /// Fires once with the transcript this session is writing to, when the
    /// relay names it. See `CaptionUploader.onTranscript`.
    var onTranscript: (@MainActor (String) -> Void)?
    /// Whether the next session uploads its lines. Set before `start()`;
    /// read once per connect, like `HTTPRelayClient.mode`.
    var keep = false

    private let engine: OnDeviceEngine
    /// A fresh uploader per kept session — a relay session is a per-session
    /// thing — injected as a factory so this type never learns URLs or tokens.
    private let makeUploader: () -> CaptionUploader
    /// The current session's uploader; nil while `keep` was false at `start()`.
    private var uploader: CaptionUploader?

    init(engine: OnDeviceEngine, makeUploader: @escaping () -> CaptionUploader) {
        self.engine = engine
        self.makeUploader = makeUploader
        engine.onClose = { [weak self] in self?.onClose?() }
        engine.onEvent = { [weak self] event in
            guard let self else { return }
            if case .caption(let text, let isFinal, _) = event, isFinal {
                self.uploader?.send(text: text, isFinal: true)
            }
            self.onEvent?(event)
        }
    }

    func start() {
        if keep {
            let uploader = makeUploader()
            uploader.onKept = { [weak self] kept in self?.onKept?(kept) }
            uploader.onTranscript = { [weak self] name in self?.onTranscript?(name) }
            self.uploader = uploader
            uploader.connect()
        } else {
            uploader = nil
        }
        engine.start()
    }

    /// Audio feeds the local engine only; nothing but text ever goes up.
    func send(_ audio: Data) {
        engine.send(audio)
    }

    func close() {
        // Closing the uploader flushes its queue and posts /v1/stop, which is
        // what finalizes the relay's transcript.
        uploader?.close()
        uploader = nil
        engine.close()
    }
}
