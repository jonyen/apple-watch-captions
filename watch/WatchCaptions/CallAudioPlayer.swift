import AVFoundation
import CaptionCore

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

    /// Silences playback while you talk, so the speaker never feeds the mic.
    var isMuted = false

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
        try? AVAudioSession.sharedInstance().setActive(false)
    }

    func play(_ samples: [Int16]) {
        guard !isMuted, !samples.isEmpty, engine.isRunning else { return }
        guard let buffer = AVAudioPCMBuffer(
            pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)) else { return }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        guard let channel = buffer.int16ChannelData else { return }
        samples.withUnsafeBufferPointer { source in
            channel[0].update(from: source.baseAddress!, count: samples.count)
        }
        player.scheduleBuffer(buffer, completionHandler: nil)
    }
}
