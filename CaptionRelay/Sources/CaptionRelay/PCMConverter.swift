import AVFoundation
import Foundation

/// Converts captured audio to the relay's wire format: 16 kHz mono
/// interleaved Int16, little-endian.
///
/// Deliberately takes its input format from each buffer rather than from a
/// format read once at tap-install time. A tap is installed immediately after
/// the audio session is activated, before the record route is guaranteed to be
/// established, so the format read there can disagree with the buffers that
/// actually arrive — and an `AVAudioConverter` pinned to the wrong input format
/// fails every conversion, silently, for the life of the session. The route can
/// also change mid-session (headphones connected, a call taking the mic), which
/// has the same effect. Rebuilding on change costs one allocation per format
/// change and removes both failure modes.
public final class PCMConverter {
    public static let wireFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!

    private let target: AVAudioFormat
    private var converter: AVAudioConverter?

    public init(target: AVAudioFormat = PCMConverter.wireFormat) {
        self.target = target
    }

    /// Wire-format bytes for `buffer`, or nil if no converter can be built for
    /// its format or the conversion itself fails. Empty input yields empty
    /// output — nothing to send, but nothing went wrong either.
    public func convert(_ buffer: AVAudioPCMBuffer) -> Data? {
        guard buffer.frameLength > 0 else { return Data() }
        guard let converter = converter(for: buffer.format) else { return nil }

        let ratio = target.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else {
            return nil
        }

        var consumed = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if consumed { status.pointee = .noDataNow; return nil }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, let channel = out.int16ChannelData else { return nil }
        return Data(bytes: channel[0], count: Int(out.frameLength) * MemoryLayout<Int16>.size)
    }

    private func converter(for format: AVAudioFormat) -> AVAudioConverter? {
        if let converter, converter.inputFormat == format { return converter }
        // A rebuilt converter starts from a clean resampler state, which is
        // what a format change means anyway.
        converter = AVAudioConverter(from: format, to: target)
        return converter
    }
}
