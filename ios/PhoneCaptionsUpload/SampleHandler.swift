import ReplayKit
import AVFoundation
import CaptionCore

/// Turns the playback audio of whatever app is on screen into relay audio.
///
/// ReplayKit hands over 44.1 kHz stereo Int16; the relay wants 16 kHz mono
/// Int16. That conversion is `PCMConverter`, already written and unit-tested for
/// the Watch and the Mac, so this file is only the plumbing between a
/// `CMSampleBuffer` and it.
///
/// Video and microphone buffers are dropped. The broadcast has to carry video
/// for the system to run at all, but nothing here wants it, and touching it
/// would only spend memory this extension does not have — the limit is 50 MB.
class SampleHandler: RPBroadcastSampleHandler {
    private let converter = PCMConverter()
    private lazy var uploader = RelayUploader(base: Secrets.relayURL, token: Secrets.authToken)

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        UploadLog.append("broadcast started")
        uploader.start()
    }

    override func broadcastFinished() {
        UploadLog.append("broadcast finished")
        uploader.stop()
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer,
                                      with sampleBufferType: RPSampleBufferType) {
        guard sampleBufferType == .audioApp else { return }
        guard let buffer = Self.pcmBuffer(from: sampleBuffer) else { return }
        guard let wire = converter.convert(buffer) else { return }
        uploader.send(wire)
    }

    /// Copies a `CMSampleBuffer`'s audio into an `AVAudioPCMBuffer`.
    ///
    /// `PCMConverter` reads its input format from each buffer it is handed, so
    /// this deliberately builds the format from the sample buffer's own stream
    /// description rather than assuming the 44.1 kHz stereo observed in
    /// testing — a route change mid-broadcast would otherwise convert silently
    /// against the wrong format for the rest of the session.
    private static func pcmBuffer(from sampleBuffer: CMSampleBuffer) -> AVAudioPCMBuffer? {
        guard let description = CMSampleBufferGetFormatDescription(sampleBuffer),
              let streamDescription =
                CMAudioFormatDescriptionGetStreamBasicDescription(description),
              let format = AVAudioFormat(streamDescription: streamDescription)
        else { return nil }

        let frames = AVAudioFrameCount(CMSampleBufferGetNumSamples(sampleBuffer))
        guard frames > 0,
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames)
        else { return nil }
        buffer.frameLength = frames

        // Copies into the buffer's own storage, so nothing here outlives the
        // sample buffer ReplayKit will reclaim when this method returns.
        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(
            sampleBuffer,
            at: 0,
            frameCount: Int32(frames),
            into: buffer.mutableAudioBufferList)
        guard status == noErr else { return nil }
        return buffer
    }
}
