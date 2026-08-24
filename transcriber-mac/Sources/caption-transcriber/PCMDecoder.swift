import AVFAudio

enum WireFormat: String {
    case pcm16k, mulaw8k
}

/// Wraps raw wire bytes into AVAudioPCMBuffers in the wire's native format.
/// µ-law is decoded to linear Int16 here (the standard G.711 expansion);
/// sample-rate conversion to the analyzer's preferred format is the
/// TranscriberSession's job.
struct PCMDecoder {
    let format: WireFormat
    let sourceFormat: AVAudioFormat

    init(format: WireFormat) {
        self.format = format
        let rate: Double = format == .pcm16k ? 16_000 : 8_000
        sourceFormat = AVAudioFormat(commonFormat: .pcmFormatInt16,
                                     sampleRate: rate, channels: 1, interleaved: true)!
    }

    func buffer(from data: Data) -> AVAudioPCMBuffer? {
        switch format {
        case .pcm16k:
            let frames = data.count / 2
            guard frames > 0,
                  let buf = AVAudioPCMBuffer(pcmFormat: sourceFormat,
                                             frameCapacity: AVAudioFrameCount(frames)) else { return nil }
            buf.frameLength = AVAudioFrameCount(frames)
            data.withUnsafeBytes { raw in
                buf.int16ChannelData![0].update(from: raw.bindMemory(to: Int16.self).baseAddress!,
                                                count: frames)
            }
            return buf
        case .mulaw8k:
            guard !data.isEmpty,
                  let buf = AVAudioPCMBuffer(pcmFormat: sourceFormat,
                                             frameCapacity: AVAudioFrameCount(data.count)) else { return nil }
            buf.frameLength = AVAudioFrameCount(data.count)
            let out = buf.int16ChannelData![0]
            for (i, byte) in data.enumerated() { out[i] = PCMDecoder.mulawToLinear(byte) }
            return buf
        }
    }

    /// G.711 µ-law expansion.
    static func mulawToLinear(_ byte: UInt8) -> Int16 {
        let u = ~byte
        let sign = (u & 0x80) != 0
        let exponent = Int((u >> 4) & 0x07)
        let mantissa = Int(u & 0x0F)
        let magnitude = ((mantissa << 3) + 0x84) << exponent
        let value = magnitude - 0x84
        return Int16(sign ? -value : value)
    }
}
