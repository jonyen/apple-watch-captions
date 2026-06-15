import Foundation
import AVFoundation
import CaptionCore

/// Captures the mic and emits 16 kHz mono Int16 PCM chunks.
final class AudioCapture: AudioCapturing {
    private let engine = AVAudioEngine()
    private var converter: AVAudioConverter?
    private let targetFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!

    func start(onChunk: @escaping (Data) -> Void) throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement)
        try session.setActive(true)

        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard let converter = AVAudioConverter(from: inputFormat, to: targetFormat) else {
            throw AudioError.converterUnavailable
        }
        self.converter = converter

        input.installTap(onBus: 0, bufferSize: 1_600, format: inputFormat) { [weak self] buffer, _ in
            guard let self, let data = self.convert(buffer), !data.isEmpty else { return }
            onChunk(data)
        }
        engine.prepare()
        try engine.start()
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        converter = nil
        try? AVAudioSession.sharedInstance().setActive(false)
    }

    private func convert(_ buffer: AVAudioPCMBuffer) -> Data? {
        guard let converter else { return nil }
        let ratio = targetFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1
        guard let out = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else {
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
        guard error == nil, let channel = out.int16ChannelData, out.frameLength > 0 else {
            return nil
        }
        return Data(bytes: channel[0], count: Int(out.frameLength) * MemoryLayout<Int16>.size)
    }

    enum AudioError: Error { case converterUnavailable }
}
