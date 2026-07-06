import ScreenCaptureKit
import AVFoundation

/// System-audio capture via ScreenCaptureKit, resampled to 16 kHz mono Int16.
/// Requires the Screen Recording permission (audio rides on the capture stream).
final class SystemAudioSource: NSObject, SCStreamOutput {
    private var stream: SCStream?
    private var converter: AVAudioConverter?
    private var onSamples: (([Int16]) -> Void)?
    private let targetFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!
    private let queue = DispatchQueue(label: "system.audio.capture")
    /// Bumped by stop() so a start() whose await was in flight during a
    /// stop()/start() cycle can detect it was superseded and tear down the
    /// SCStream it just spun up instead of orphaning it in self.stream.
    ///
    /// Race this guards against: DualCapture.start() dispatches system audio
    /// capture on a detached Task (SCShareableContent lookup can take ~100s
    /// of ms). If DualCapture.stop() runs before that Task even begins
    /// executing, a generation read *inside* this function would already
    /// reflect the post-stop value and see no mismatch, letting a capture
    /// start that nobody will ever stop (the recording indicator stays on
    /// forever). So the caller snapshots `currentGeneration` synchronously
    /// (before creating the Task) and passes it in as `expectedGeneration`;
    /// we compare against that fixed snapshot both before and after each
    /// await, so a stop() at any point — even before this function starts
    /// running — is caught.
    private var generation = 0
    var currentGeneration: Int { generation }

    func start(expectedGeneration: Int, onSamples: @escaping ([Int16]) -> Void) async throws {
        guard generation == expectedGeneration else { return } // stopped before we even began
        self.onSamples = onSamples
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard generation == expectedGeneration else { return } // stopped during the shareable-content lookup
        guard let display = content.displays.first else { throw CaptureError.noDisplay }

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        // Keep video overhead minimal; we only want audio.
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)

        let stream = SCStream(filter: filter, configuration: config, delegate: nil)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        try await stream.startCapture()

        guard generation == expectedGeneration else {
            // A stop() (and possibly a new start()) raced this await; this
            // stream is stale, so shut it down rather than assigning it.
            try? await stream.stopCapture()
            return
        }
        self.stream = stream
    }

    func stop() {
        generation += 1
        let s = stream
        stream = nil
        converter = nil
        onSamples = nil
        Task { try? await s?.stopCapture() }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio,
              let onSamples,
              let pcm = sampleBuffer.toPCMBuffer() else { return }
        if converter == nil || converter?.inputFormat != pcm.format {
            converter = AVAudioConverter(from: pcm.format, to: targetFormat)
        }
        guard let converter else { return }
        let ratio = targetFormat.sampleRate / pcm.format.sampleRate
        let capacity = AVAudioFrameCount(Double(pcm.frameLength) * ratio) + 1
        guard let out = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { return }
        var consumed = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if consumed { status.pointee = .noDataNow; return nil }
            consumed = true
            status.pointee = .haveData
            return pcm
        }
        guard error == nil, let channel = out.int16ChannelData, out.frameLength > 0 else { return }
        onSamples(Array(UnsafeBufferPointer(start: channel[0], count: Int(out.frameLength))))
    }

    enum CaptureError: Error { case noDisplay }
}

private extension CMSampleBuffer {
    /// Wrap a ScreenCaptureKit audio sample buffer in an AVAudioPCMBuffer.
    func toPCMBuffer() -> AVAudioPCMBuffer? {
        guard let desc = CMSampleBufferGetFormatDescription(self),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(desc),
              let format = AVAudioFormat(streamDescription: asbd) else { return nil }
        let frames = AVAudioFrameCount(CMSampleBufferGetNumSamples(self))
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { return nil }
        buffer.frameLength = frames
        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(
            self, at: 0, frameCount: Int32(frames), into: buffer.mutableAudioBufferList)
        return status == noErr ? buffer : nil
    }
}
