import Foundation
import CaptionCore

/// Captures mic + system audio, interleaving them into 100 ms stereo chunks
/// (ch0 = mic, ch1 = system). Conforms to CaptionCore.AudioCapturing so
/// SessionController drives it exactly like the watch's mono capture.
final class DualCapture: AudioCapturing {
    private let micEnabled: () -> Bool
    private let systemEnabled: () -> Bool
    private let mic = MicSource()
    private let system = SystemAudioSource()
    private let interleaver = Interleaver()
    private var timer: DispatchSourceTimer?
    private let queue = DispatchQueue(label: "dualcapture.drain")
    private var started = false

    init(micEnabled: @escaping () -> Bool, systemEnabled: @escaping () -> Bool) {
        self.micEnabled = micEnabled
        self.systemEnabled = systemEnabled
    }

    func start(onChunk: @escaping (Data) -> Void) throws {
        guard !started else { return }
        started = true
        if micEnabled() {
            try mic.start { [interleaver] in interleaver.pushMic($0) }
        }
        if systemEnabled() {
            let system = self.system
            let interleaver = self.interleaver
            Task {
                do {
                    try await system.start { interleaver.pushSystem($0) }
                } catch {
                    // System capture failing shouldn't kill the mic-only session.
                    print("system audio capture failed: \(error)")
                }
            }
        }
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 0.1, repeating: 0.1)
        t.setEventHandler { [interleaver] in
            let data = interleaver.drainStereoFrames()
            if !data.isEmpty { onChunk(data) }
        }
        t.resume()
        timer = t
    }

    func stop() {
        started = false
        timer?.cancel()
        timer = nil
        mic.stop()
        system.stop()
    }
}
