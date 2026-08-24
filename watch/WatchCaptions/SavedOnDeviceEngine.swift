import Foundation
import CaptionCore

/// The on-device engine, with the transcript kept: a `MoonshineEngine` does
/// the captioning exactly as in an unkept session, and every final line it
/// produces is also forwarded to the relay over a `CaptionUploader`, so the
/// session ends up stored — and summarized and exported — like any saved
/// relay session.
///
/// Composition, not a mode inside `MoonshineEngine`: this type owns the
/// engine plus, per kept session, an uploader, and adds nothing beyond the
/// forwarding. `keep` follows `HTTPRelayClient.mode`'s lifecycle — set before
/// `start()`, read once per connect — so one instance (and one loaded model)
/// serves both kept and unkept sessions. Finals only go up: partials repaint
/// several times a second and the relay stores lines, not repaints.
///
/// The uploader can never fail the session — see `CaptionUploader` — so
/// `onEvent`/`onClose` are Moonshine's alone; the uploader reports only
/// through `onKept`, which drives the captions screen's saved/not-saved
/// indicator.
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
    /// Whether the next session uploads its lines. Set before `start()`;
    /// read once per connect, like `HTTPRelayClient.mode`.
    var keep = false

    private let engine: MoonshineEngine
    /// A fresh uploader per kept session — a socket is a per-session thing —
    /// injected as a factory so this type never learns URLs or tokens.
    private let makeUploader: () -> CaptionUploader
    /// The current session's socket; nil while `keep` was false at `start()`.
    private var uploader: CaptionUploader?

    init(engine: MoonshineEngine, makeUploader: @escaping () -> CaptionUploader) {
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
        // Closing the socket is what finalizes the relay's transcript.
        uploader?.close()
        uploader = nil
        engine.close()
    }
}
