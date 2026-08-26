import Foundation
import CaptionCore

/// The on-device engine, with the transcript kept: a `OnDeviceEngine` does
/// the captioning exactly as in an unkept session, and every final line it
/// produces is also posted to the relay through a `CaptionUploader`, so the
/// session ends up stored — and summarized and exported — like any saved
/// relay session. Alongside that, the same raw audio Moonshine is
/// captioning is also streamed to the relay's audio-archive endpoint through
/// an `AudioArchiveUploader`, under the exact same relay session id, so the
/// relay can build a self-labeled fine-tuning dataset from it.
///
/// Composition, not a mode inside `OnDeviceEngine`: this type owns the
/// engine plus, per kept session, an uploader pair, and adds nothing beyond
/// the forwarding. `keep` follows `HTTPRelayClient.mode`'s lifecycle — set
/// before `start()`, read once per connect — so one instance (and one
/// loaded model) serves both kept and unkept sessions. Finals only go up to
/// the caption uploader: partials repaint several times a second and the
/// relay stores lines, not repaints. Audio, by contrast, goes to the archive
/// uploader in full — archiving cares about the raw signal, not text.
///
/// Neither uploader can ever fail the session — see `CaptionUploader` and
/// `AudioArchiveUploader` — so `onEvent`/`onClose` are Moonshine's alone; the
/// caption uploader reports only through `onKept`, which drives the
/// captions screen's saved/not-saved indicator, and `onTranscript`, which
/// names the relay transcript so the app can offer to resume it later. The
/// archive uploader reports nothing at all — a failed or dropped archive
/// batch must never move `onKept`, which reflects caption persistence only.
///
/// Not `Sendable` and needs no lock: `start()`/`close()` run on the main
/// actor (`SessionController` is `@MainActor`) and the engine tap below is a
/// `@MainActor` closure, so both uploaders are main-actor-confined;
/// `send(_:)`, the one call off it, touches the engine and the archive
/// uploader, both of which are thread-safe on their own.
final class SavedOnDeviceEngine: CaptionEngine {
    var onEvent: (@MainActor (CaptionEvent) -> Void)?
    var onClose: (@MainActor () -> Void)?
    /// Fires with whether this session's lines are reaching the relay. See
    /// `CaptionUploader.onKept`. Reflects caption persistence only — the
    /// audio archive never touches this.
    var onKept: (@MainActor (Bool) -> Void)?
    /// Fires once with the transcript this session is writing to, when the
    /// relay names it. See `CaptionUploader.onTranscript`.
    var onTranscript: (@MainActor (String) -> Void)?
    /// Whether the next session uploads its lines (and archives its audio).
    /// Set before `start()`; read once per connect, like `HTTPRelayClient.mode`.
    var keep = false

    private let engine: OnDeviceEngine
    /// A fresh uploader per kept session — a relay session is a per-session
    /// thing — injected as a factory so this type never learns URLs or tokens.
    private let makeUploader: () -> CaptionUploader
    /// A fresh archive uploader per kept session, given the exact session id
    /// the caption uploader just minted, so both land under one relay
    /// session. Injected the same way `makeUploader` is.
    private let makeAudioArchiveUploader: (String) -> AudioArchiveUploader
    /// The current session's uploaders; nil while `keep` was false at `start()`.
    private var uploader: CaptionUploader?
    private var audioArchiveUploader: AudioArchiveUploader?

    init(
        engine: OnDeviceEngine,
        makeUploader: @escaping () -> CaptionUploader,
        makeAudioArchiveUploader: @escaping (String) -> AudioArchiveUploader
    ) {
        self.engine = engine
        self.makeUploader = makeUploader
        self.makeAudioArchiveUploader = makeAudioArchiveUploader
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

            // Same session id the caption uploader just minted, so the
            // relay's one `/v1/stop` for this session finalizes both the
            // transcript and the archive.
            let archiveUploader = makeAudioArchiveUploader(uploader.sessionID)
            self.audioArchiveUploader = archiveUploader
            archiveUploader.connect()
        } else {
            uploader = nil
            audioArchiveUploader = nil
        }
        engine.start()
    }

    /// Feeds the local engine (the source of every caption) and, when kept,
    /// the archive uploader with the same raw audio. Archiving is purely
    /// additive: nothing about this call can affect captioning — an unkept
    /// session (`audioArchiveUploader` nil) sends this audio nowhere but the
    /// local engine, exactly as before this type existed.
    func send(_ audio: Data) {
        engine.send(audio)
        audioArchiveUploader?.send(audio)
    }

    func close() {
        // Closing the caption uploader flushes its queue and posts
        // /v1/stop, which is what finalizes the relay's transcript *and*
        // (unconditionally, on the relay) any archived audio for this same
        // session — see AudioArchiveUploader's doc comment. The archive
        // uploader is closed first so its own queued audio is on its way
        // before that stop lands; both are still best-effort, the same way
        // CaptionUploader.close()'s own /v1/stop is.
        audioArchiveUploader?.close()
        audioArchiveUploader = nil
        uploader?.close()
        uploader = nil
        engine.close()
    }
}
