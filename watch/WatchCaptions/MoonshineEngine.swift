import Foundation
import os
import CaptionCore
import MoonshineKit

/// On-device captions: Moonshine (Base) on Core ML, fed the same 16 kHz mono
/// Int16 PCM `AudioCapture` sends the relay. Models load once, on the first
/// `start()`, and stay loaded for the life of the app — loading is the slow
/// part, not inference.
final class MoonshineEngine: CaptionEngine {
    var onEvent: (@MainActor (CaptionEvent) -> Void)?
    var onClose: (@MainActor () -> Void)?

    /// Where `project.yml` puts the folder `Scripts/fetch-moonshine.sh` downloads.
    static let bundledModels = Bundle.main.resourceURL!.appendingPathComponent("Moonshine")

    /// Inference errors in a row before the session is given up on; one bad
    /// segment is dropped silently and the next one gets its chance.
    static let failureLimit = 3

    /// Audio kept while the models load, so the first sentence spoken after
    /// tapping the row is captioned instead of lost. 30 s at 16 kHz; beyond
    /// that the oldest audio gives way.
    static let loadBufferLimit = 480_000

    private let modelDirectory: URL
    private let lock = NSLock()
    private var live: LiveTranscriber?
    private var loading = false
    private var pending: [Int16] = []
    private var consecutiveFailures = 0
    private let log = Logger(subsystem: "com.jonyen.watchcaptions", category: "MoonshineEngine")

    init(modelDirectory: URL = MoonshineEngine.bundledModels) {
        self.modelDirectory = modelDirectory
    }

    /// Reports `.ready` immediately — before the models have loaded — so the
    /// session controller starts the mic while the app is still frontmost.
    /// watchOS refuses to *begin* recording from the background, and the model
    /// load takes long enough for the wrist to drop; once recording is live,
    /// the audio background mode keeps it running. Audio arriving before the
    /// models are up is buffered and transcribed when they are.
    func start() {
        lock.lock()
        consecutiveFailures = 0
        if let live {
            live.reset()
            lock.unlock()
            emit(.ready)
            return
        }
        if loading {
            lock.unlock()
            emit(.ready)
            return
        }
        loading = true
        lock.unlock()
        emit(.ready)

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
                // Drain buffered audio into the transcriber before publishing
                // it: once `self.live` is set the audio thread feeds directly,
                // and a chunk must never land ahead of the speech that
                // preceded it. New audio can arrive during a drain, so loop
                // until a drain finds the buffer empty.
                while true {
                    self.lock.lock()
                    let buffered = self.pending
                    self.pending.removeAll()
                    if buffered.isEmpty {
                        self.live = live
                        self.loading = false
                        self.lock.unlock()
                        break
                    }
                    self.lock.unlock()
                    live.feed(buffered)
                }
            } catch {
                self?.log.error("model load failed: \(String(describing: error), privacy: .public)")
                self?.lock.lock()
                self?.loading = false
                self?.pending.removeAll()
                self?.lock.unlock()
                self?.emit(.error(message: "On-device model failed to load"))
            }
        }
    }

    /// Called on the audio thread.
    func send(_ audio: Data) {
        guard audio.count >= 2 else { return }
        lock.lock()
        guard let live else {
            if loading {
                var samples = [Int16](repeating: 0, count: audio.count / 2)
                _ = samples.withUnsafeMutableBytes { audio.copyBytes(to: $0) }
                pending.append(contentsOf: samples)
                if pending.count > Self.loadBufferLimit {
                    pending.removeFirst(pending.count - Self.loadBufferLimit)
                }
            }
            lock.unlock()
            return
        }
        lock.unlock()
        var samples = [Int16](repeating: 0, count: audio.count / 2)
        _ = samples.withUnsafeMutableBytes { audio.copyBytes(to: $0) }
        live.feed(samples)
    }

    /// Drops the open segment and anything queued; keeps the models.
    /// `SessionController.stop()` has already cleared `running`, so a final
    /// flushed here would be discarded anyway.
    func close() {
        lock.lock()
        pending.removeAll()
        let live = self.live
        lock.unlock()
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
