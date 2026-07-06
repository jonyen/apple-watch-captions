import Foundation

/// Merges two mono 16 kHz Int16 streams into interleaved stereo frames
/// (channel 0 = mic, channel 1 = system audio). Thread-safe: capture callbacks
/// push from audio threads; a timer drains on a worker queue.
final class Interleaver {
    private var mic: [Int16] = []
    private var system: [Int16] = []
    private let lock = NSLock()

    func pushMic(_ samples: [Int16]) {
        lock.lock(); defer { lock.unlock() }
        mic.append(contentsOf: samples)
    }

    func pushSystem(_ samples: [Int16]) {
        lock.lock(); defer { lock.unlock() }
        system.append(contentsOf: samples)
    }

    /// Interleave everything buffered so far, padding the shorter channel with
    /// silence so the two stay time-aligned. Returns little-endian PCM bytes.
    func drainStereoFrames() -> Data {
        lock.lock()
        let m = mic, s = system
        mic = []; system = []
        lock.unlock()

        let frames = max(m.count, s.count)
        guard frames > 0 else { return Data() }
        var out = [Int16](repeating: 0, count: frames * 2)
        for f in 0..<frames {
            out[f * 2] = f < m.count ? m[f] : 0
            out[f * 2 + 1] = f < s.count ? s[f] : 0
        }
        return out.withUnsafeBufferPointer { Data(buffer: $0) }
    }
}
