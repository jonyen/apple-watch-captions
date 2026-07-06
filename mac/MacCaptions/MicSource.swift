import AVFoundation

/// Mic capture producing 16 kHz mono Int16 samples (same conversion approach
/// as the watch AudioCapture, minus AVAudioSession, which doesn't exist on macOS).
final class MicSource {
    private let engine = AVAudioEngine()
    private var converter: AVAudioConverter?
    private let targetFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!

    func start(onSamples: @escaping ([Int16]) -> Void) throws {
        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard let converter = AVAudioConverter(from: inputFormat, to: targetFormat) else {
            throw CaptureError.converterUnavailable
        }
        self.converter = converter

        input.installTap(onBus: 0, bufferSize: 1_600, format: inputFormat) { [weak self] buffer, _ in
            guard let self, let samples = self.convert(buffer), !samples.isEmpty else { return }
            onSamples(samples)
        }
        engine.prepare()
        try engine.start()
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        converter = nil
    }

    private func convert(_ buffer: AVAudioPCMBuffer) -> [Int16]? {
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
        return Array(UnsafeBufferPointer(start: channel[0], count: Int(out.frameLength)))
    }

    enum CaptureError: Error { case converterUnavailable }
}
