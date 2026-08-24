import Foundation
import os
import CaptionCore
import MoonshineKit

/// On-device captions: Moonshine Tiny on Core ML, fed the same 16 kHz mono
/// Int16 PCM `AudioCapture` sends the relay. Models load once, on the first
/// `start()`, and stay loaded for the life of the app — loading is the slow
/// part, not inference.
final class MoonshineEngine: CaptionEngine {
    var onEvent: (@MainActor (CaptionEvent) -> Void)?
    var onClose: (@MainActor () -> Void)?

    /// Where `project.yml` puts the folder `Scripts/fetch-moonshine.sh` downloads.
    static let bundledModels = Bundle.main.resourceURL!.appendingPathComponent("MoonshineTiny")

    /// Inference errors in a row before the session is given up on; one bad
    /// segment is dropped silently and the next one gets its chance.
    static let failureLimit = 3

    private let modelDirectory: URL
    private let lock = NSLock()
    private var live: LiveTranscriber?
    private var loading = false
    private var consecutiveFailures = 0
    private let log = Logger(subsystem: "com.jonyen.watchcaptions", category: "MoonshineEngine")

    init(modelDirectory: URL = MoonshineEngine.bundledModels) {
        self.modelDirectory = modelDirectory
    }

    func start() {
        lock.lock()
        consecutiveFailures = 0
        if let live {
            live.reset()
            lock.unlock()
            emit(.ready)
            return
        }
        guard !loading else { lock.unlock(); return }
        loading = true
        lock.unlock()

        let directory = modelDirectory
        Task.detached(priority: .userInitiated) { [weak self] in
            do {
                // CPU only: on watch hardware the ANE accepts this model at
                // load but fails every prediction (ANEProgramProcessRequestDirect
                // status=0x1d), and Core ML does not fall back at that point.
                let model = try MoonshineModel(directory: directory, computeUnits: .cpuOnly)
                let live = LiveTranscriber(transcriber: Transcriber(model: model))
                guard let self else { return }
                live.onPartial = { [weak self] text in self?.report(text, isFinal: false) }
                live.onFinal = { [weak self] text in self?.report(text, isFinal: true) }
                live.onError = { [weak self] error in self?.failed(error) }
                self.lock.lock()
                self.live = live
                self.loading = false
                self.lock.unlock()
                self.emit(.ready)
            } catch {
                self?.log.error("model load failed: \(String(describing: error), privacy: .public)")
                self?.lock.lock(); self?.loading = false; self?.lock.unlock()
                self?.emit(.error(message: "On-device model failed to load"))
            }
        }
    }

    /// Called on the audio thread.
    func send(_ audio: Data) {
        lock.lock(); let live = self.live; lock.unlock()
        guard let live, audio.count >= 2 else { return }
        var samples = [Int16](repeating: 0, count: audio.count / 2)
        _ = samples.withUnsafeMutableBytes { audio.copyBytes(to: $0) }
        live.feed(samples)
    }

    /// Drops the open segment and anything queued; keeps the models.
    /// `SessionController.stop()` has already cleared `running`, so a final
    /// flushed here would be discarded anyway.
    func close() {
        lock.lock(); let live = self.live; lock.unlock()
        live?.reset()
    }

    // MARK: - Results

    private func report(_ text: String, isFinal: Bool) {
        lock.lock(); consecutiveFailures = 0; lock.unlock()
        emit(.caption(text: text, isFinal: isFinal, channel: nil))
    }

    private func failed(_ error: Error) {
        log.error("inference failed: \(String(describing: error), privacy: .public)")
        lock.lock()
        consecutiveFailures += 1
        let giveUp = consecutiveFailures >= Self.failureLimit
        lock.unlock()
        if giveUp { emit(.error(message: "On-device captions failed")) }
    }

    /// Main-queue FIFO, so a partial can never overtake the final that supersedes it.
    private func emit(_ event: CaptionEvent) {
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated { self?.onEvent?(event) }
        }
    }
}
