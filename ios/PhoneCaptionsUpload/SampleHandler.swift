import ReplayKit
import AVFoundation
import CaptionRelay

/// Turns the playback audio of whatever app is on screen into relay audio.
///
/// ReplayKit hands over 44.1 kHz stereo Int16; the relay wants 16 kHz mono
/// Int16. That conversion is `PCMConverter`, already written and unit-tested for
/// the Watch and the Mac, so this file is only the plumbing between a
/// `CMSampleBuffer` and it.
///
/// This is a digital tap, not a microphone: it hears what the app is playing
/// even through headphones, and it does not hear the room.
///
/// Video and microphone buffers are dropped. The broadcast has to carry video
/// for the system to run at all, but nothing here wants it, and touching it
/// would only spend memory this extension does not have — the limit is 50 MB.
class SampleHandler: RPBroadcastSampleHandler {
    private let converter = PCMConverter()
    private lazy var uploader = RelayUploader(
        base: Secrets.relayURL, token: { try await DeviceIdentity.shared.token() })
    private lazy var presence = PresenceWatcher(
        base: Secrets.relayURL, token: { try await DeviceIdentity.shared.token() })
    /// Whether the Watch is reading. Audio captured while nobody is watching is
    /// dropped rather than sent — the broadcast may be running for a while
    /// before you look at your wrist, and those minutes are billed by the
    /// transcriber if they reach the relay.
    private var streaming = false

    private var reportedFirstBuffer = false

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        UploadLog.append("broadcast started")
        presence.start { [weak self] reader in
            guard let self, reader != self.streaming else { return }
            self.streaming = reader
            if reader {
                UploadLog.append("reader present — streaming")
                self.uploader.start()
            } else {
                UploadLog.append("no reader — idle")
                self.uploader.stop()
            }
        }
    }

    override func broadcastFinished() {
        UploadLog.append("broadcast finished")
        presence.stop()
        uploader.stop()
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer,
                                      with sampleBufferType: RPSampleBufferType) {
        guard sampleBufferType == .audioApp, streaming else { return }
        guard let buffer = Self.pcmBuffer(from: sampleBuffer) else {
            reportFirstBuffer(nil, nil)
            return
        }
        let wire = converter.convert(buffer)
        reportFirstBuffer(buffer, wire)
        guard let wire, !wire.isEmpty else { return }
        uploader.send(wire)
    }

    /// Says once what the audio path actually produced. A tap that delivers
    /// buffers nothing can convert fails silently in every other way — no
    /// error, no throw, and an app that goes on reporting success.
    private func reportFirstBuffer(_ buffer: AVAudioPCMBuffer?, _ wire: Data?) {
        guard !reportedFirstBuffer else { return }
        reportedFirstBuffer = true
        guard let buffer else {
            UploadLog.append("first app-audio buffer: COULD NOT READ SAMPLE BUFFER")
            return
        }
        UploadLog.append(
            "first app-audio buffer: \(Int(buffer.format.sampleRate)) Hz, "
            + "\(buffer.format.channelCount) ch, \(buffer.frameLength) frames → "
            + (wire.map { "\($0.count) bytes" } ?? "CONVERSION FAILED"))
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
