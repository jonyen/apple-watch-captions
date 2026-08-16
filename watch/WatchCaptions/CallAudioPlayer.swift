import AVFoundation
import CaptionCore
import CaptionRelay

/// Plays the caller's audio as it arrives.
///
/// Audio comes in roughly one-second batches over HTTP, so this schedules each
/// batch onto a player node as it lands rather than trying to keep a smooth
/// clock. Gaps are audible and expected — that is the cost of a transport that
/// cannot hold a socket open.
final class CallAudioPlayer {
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    /// Telephony audio, matching what the relay forwards.
    private let format = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: 8_000, channels: 1, interleaved: true)!
    private var converter = PCMConverter()

    /// Frames scheduled on `player` but not yet finished playing, guarded by
    /// `queueLock` since it's written from both `play(_:)` (the poller) and
    /// each buffer's completion handler (an AVAudioEngine render thread).
    private let queueLock = NSLock()
    private var framesQueued: AVAudioFrameCount = 0
    /// ~2s of 8kHz audio: enough to absorb one slow HTTP poll without an
    /// audible gap, short enough that a backlog never drifts far behind the
    /// live caller. Not tuned against real network jitter yet — a starting
    /// point, adjust if playback lags or gaps too often in practice.
    private static let maxQueuedFrames: AVAudioFrameCount = 16_000

    /// Silences playback while you talk, so the speaker never feeds the mic.
    /// Set through `mute()`/`unmute()`, never directly: gating alone is not
    /// silence, and the difference is audible on the call.
    private(set) var isMuted = false

    /// Microphone audio, as 16 kHz Int16 — the format the relay expects.
    /// Delivered continuously; `CallVoice` decides what belongs to a turn.
    var onCapturedPCM: ((Data) -> Void)?

    /// One engine owns both directions. Capture cannot live in `AudioCapture`
    /// alongside this: that class activates the session as `.record` with
    /// `.measurement`, which would fight the `.playAndRecord`/`.voiceChat`
    /// configuration playback needs and silence one side or the other.
    func start() throws {
        let session = AVAudioSession.sharedInstance()
        // Playback and capture coexist for the whole call rather than
        // renegotiating per turn, which would clip the start of each one.
        // `.defaultToSpeaker` is iOS-only — watchOS has no receiver/speaker
        // split to override, so `.voiceChat` alone picks the right route.
        try session.setCategory(.playAndRecord, mode: .voiceChat)
        try session.setActive(true)

        converter = PCMConverter()
        // A call never begins muted, whatever the last one ended in.
        isMuted = false
        queueLock.lock()
        framesQueued = 0
        queueLock.unlock()
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)

        // `format: nil` taps the bus as it is actually running — the lesson
        // from the blank-captions bug, where a snapshot taken here was stale.
        let input = engine.inputNode
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1_600, format: nil) { [weak self] buffer, _ in
            guard let self, let pcm = self.converter.convert(buffer), !pcm.isEmpty else { return }
            self.onCapturedPCM?(pcm)
        }

        engine.prepare()
        try engine.start()
        player.play()
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        player.stop()
        engine.stop()
        queueLock.lock()
        framesQueued = 0
        queueLock.unlock()
        try? AVAudioSession.sharedInstance().setActive(false)
    }

    /// Silence the speaker for a push-to-talk turn.
    ///
    /// Flushes what is already scheduled rather than only gating what comes
    /// next: up to two seconds of the caller can be sitting on the player
    /// node, and that audio would go on rendering into an open microphone —
    /// sending the caller back to themselves about four seconds late, which
    /// is exactly what push-to-talk exists to prevent. Nothing else catches
    /// it: `AudioCapture` uses `.measurement` mode, which disables the
    /// processing that would cancel an echo, and a delay this long is the
    /// case echo cancellers handle worst.
    ///
    /// `player.stop()` is what discards them. Completion handlers for the
    /// discarded buffers may still run afterwards; `framesQueued` is reset
    /// here and its decrement clamps at zero, so a late handler cannot drive
    /// the count negative.
    func mute() {
        guard !isMuted else { return }
        isMuted = true
        player.stop()
        queueLock.lock()
        framesQueued = 0
        queueLock.unlock()
    }

    /// Let the caller be heard again. `player.stop()` left the node stopped,
    /// so it has to be restarted or every later `scheduleBuffer` would queue
    /// against a node that never renders.
    func unmute() {
        guard isMuted else { return }
        isMuted = false
        if engine.isRunning { player.play() }
    }

    func play(_ samples: [Int16]) {
        guard !isMuted, !samples.isEmpty, engine.isRunning else { return }
        let incoming = AVAudioFrameCount(samples.count)

        queueLock.lock()
        let wouldExceed = framesQueued + incoming > Self.maxQueuedFrames
        queueLock.unlock()
        // The caller is live; stale audio is worthless. Rather than let the
        // queue grow and playback drift further behind, drop this chunk and
        // stay near real time — the gap that leaves is the lesser cost.
        guard !wouldExceed else { return }

        guard let buffer = AVAudioPCMBuffer(
            pcmFormat: format, frameCapacity: incoming) else { return }
        buffer.frameLength = incoming
        guard let channel = buffer.int16ChannelData else { return }
        samples.withUnsafeBufferPointer { source in
            channel[0].update(from: source.baseAddress!, count: samples.count)
        }

        queueLock.lock()
        framesQueued += incoming
        queueLock.unlock()
        player.scheduleBuffer(buffer) { [weak self] in
            guard let self else { return }
            self.queueLock.lock()
            self.framesQueued = self.framesQueued > incoming ? self.framesQueued - incoming : 0
            self.queueLock.unlock()
        }
    }
}
