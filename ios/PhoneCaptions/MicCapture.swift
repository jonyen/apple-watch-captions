import AVFoundation
import CaptionCore

/// The phone's microphone, running continuously.
///
/// Mirrors the Watch's own `AudioCapture`: tap the input node, convert each
/// buffer to the relay's wire format with `PCMConverter`, hand it on. The
/// difference is lifetime — this one is meant to stay running for hours with
/// the screen off, which is what `UIBackgroundModes: audio` buys.
///
/// `.measurement` mode for the same reason the Watch uses it: it disables the
/// processing that shapes audio for a phone call, which is not what a
/// transcriber wants.
final class MicCapture {
    private let engine = AVAudioEngine()
    private let converter = PCMConverter()
    private var onChunk: ((Data) -> Void)?
    private(set) var running = false

    /// Starts capture. `onChunk` is called on the audio thread, so it must not
    /// block — the uploader hands straight off to its own queue.
    func start(onChunk: @escaping (Data) -> Void) throws {
        guard !running else { return }
        self.onChunk = onChunk

        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement)
        try session.setActive(true)

        let input = engine.inputNode
        // The node's own format, not a chosen one: an input tap must be
        // installed with the hardware's format, and `PCMConverter` reads the
        // format from each buffer anyway, so a route change mid-session
        // converts correctly rather than silently producing nothing.
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, _ in
            guard let self, let wire = self.converter.convert(buffer) else { return }
            self.onChunk?(wire)
        }

        engine.prepare()
        try engine.start()
        running = true
    }

    func stop() {
        guard running else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        running = false
        onChunk = nil
        try? AVAudioSession.sharedInstance().setActive(false)
    }
}
