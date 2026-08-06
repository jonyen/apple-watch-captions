import Foundation
import AVFoundation
import CaptionCore

/// Captures the mic and emits 16 kHz mono Int16 PCM chunks.
final class AudioCapture: AudioCapturing {
    private let engine = AVAudioEngine()
    private var converter = PCMConverter()

    func start(onChunk: @escaping (Data) -> Void) throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement)
        try session.setActive(true)

        // A fresh converter per session: the previous one is primed for
        // whichever route the last session ran on.
        converter = PCMConverter()

        let input = engine.inputNode
        // `format: nil` taps the bus in whatever format it is actually running
        // in. Passing a format read here instead is what produced silent, blank
        // sessions: this runs immediately after `setActive(true)`, before the
        // record route is guaranteed established, so the format read can be
        // stale — and every buffer delivered in the real format then failed to
        // convert, with nothing thrown and nothing shown. See PCMConverter.
        input.installTap(onBus: 0, bufferSize: 1_600, format: nil) { [weak self] buffer, _ in
            guard let self, let data = self.converter.convert(buffer), !data.isEmpty else { return }
            onChunk(data)
        }
        engine.prepare()
        try engine.start()
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        try? AVAudioSession.sharedInstance().setActive(false)
    }
}
