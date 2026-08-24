import Foundation
import Speech
@preconcurrency import AVFAudio

/// Wraps one SpeechAnalyzer/SpeechTranscriber pipeline: wire bytes in
/// (`feed`), transcript events out (`events`).
///
/// Ordering: `feed` yields raw Data into an AsyncStream consumed by a single
/// pump task, which decodes, converts to the analyzer's preferred format, and
/// forwards buffers to the analyzer — so buffers reach the analyzer in call
/// order (the sketch's Task-per-feed would not guarantee that).
///
/// Lifecycle: callers MUST call `finish()` when the input ends — it drains
/// remaining audio, delivers the final transcript, and completes `events`.
/// A session dropped without `finish()` is reclaimed by a best-effort deinit
/// (tasks cancelled, streams finished), but the final transcript is lost.
actor TranscriberSession {
    enum Event {
        case ready
        case transcript(text: String, isFinal: Bool)
        case error(String)
    }

    let events: AsyncStream<Event>
    private let eventsIn: AsyncStream<Event>.Continuation
    private let feedIn: AsyncStream<Data>.Continuation
    private let analyzer: SpeechAnalyzer
    private var resultsTask: Task<Void, Never>?
    private var pumpTask: Task<Void, Never>?

    /// How long `finish()` waits for the analyzer to finalize before forcing
    /// the streams closed so consumers never hang.
    private static let finishTimeout: UInt64 = 10_000_000_000  // 10 s

    /// Downloads the on-device transcription model for `locale` if needed.
    static func ensureModel(locale: Locale) async throws {
        guard let supported = await SpeechTranscriber.supportedLocale(equivalentTo: locale) else {
            throw NSError(domain: "transcriber", code: 3,
                          userInfo: [NSLocalizedDescriptionKey:
                                        "locale \(locale.identifier) not supported by SpeechTranscriber"])
        }
        let reserved = await AssetInventory.reservedLocales
        if !reserved.contains(where: { $0.identifier(.bcp47) == supported.identifier(.bcp47) }) {
            try await AssetInventory.reserve(locale: supported)
        }
        let transcriber = SpeechTranscriber(locale: supported, preset: .progressiveTranscription)
        if await AssetInventory.status(forModules: [transcriber]) == .installed { return }
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            try await request.downloadAndInstall()
        }
    }

    init(locale: Locale, format: WireFormat) async throws {
        let transcriber = SpeechTranscriber(locale: locale,
                                            transcriptionOptions: [],
                                            reportingOptions: [.volatileResults],
                                            attributeOptions: [])
        // Note: bestAvailableAudioFormat lives on SpeechAnalyzer, not SpeechTranscriber.
        guard let analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
            throw NSError(domain: "transcriber", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "no analyzer audio format"])
        }
        let decoder = PCMDecoder(format: format)
        guard let converter = AVAudioConverter(from: decoder.sourceFormat, to: analyzerFormat) else {
            throw NSError(domain: "transcriber", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "no converter to analyzer format"])
        }

        (events, eventsIn) = AsyncStream<Event>.makeStream()
        let (feedStream, feedContinuation) = AsyncStream<Data>.makeStream()
        feedIn = feedContinuation
        let (inputStream, inputBuilder) = AsyncStream<AnalyzerInput>.makeStream()

        analyzer = SpeechAnalyzer(modules: [transcriber])

        // Start the analyzer BEFORE spawning the worker tasks: if start throws,
        // no tasks exist to leak. No results can be missed — audio only flows
        // once the pump task runs.
        do {
            try await analyzer.start(inputSequence: inputStream)
        } catch {
            feedIn.finish()
            inputBuilder.finish()
            eventsIn.finish()
            throw error
        }

        resultsTask = Task { [eventsIn] in
            do {
                for try await result in transcriber.results {
                    eventsIn.yield(.transcript(text: String(result.text.characters),
                                               isFinal: result.isFinal))
                }
            } catch {
                eventsIn.yield(.error(String(describing: error)))
            }
            // The results sequence ending (normally or on error) means no more
            // transcripts can ever arrive — complete `events` so consumers
            // never hang on a dead session.
            eventsIn.finish()
        }

        pumpTask = Task {
            let ratio = analyzerFormat.sampleRate / decoder.sourceFormat.sampleRate
            for await data in feedStream {
                guard let src = decoder.buffer(from: data) else { continue }
                let capacity = AVAudioFrameCount((Double(src.frameLength) * ratio).rounded(.up)) + 16
                guard let dst = AVAudioPCMBuffer(pcmFormat: analyzerFormat, frameCapacity: capacity) else { continue }
                var fed = false
                var convError: NSError?
                let status = converter.convert(to: dst, error: &convError) { _, outStatus in
                    if fed { outStatus.pointee = .noDataNow; return nil }
                    fed = true
                    outStatus.pointee = .haveData
                    return src
                }
                if convError == nil, status != .error, dst.frameLength > 0 {
                    inputBuilder.yield(AnalyzerInput(buffer: dst))
                }
            }
            // Drain any tail the rate converter is still holding (matters for 8k -> 16k).
            if ratio != 1.0, let tail = AVAudioPCMBuffer(pcmFormat: analyzerFormat, frameCapacity: 4096) {
                var convError: NSError?
                converter.convert(to: tail, error: &convError) { _, outStatus in
                    outStatus.pointee = .endOfStream
                    return nil
                }
                if convError == nil, tail.frameLength > 0 {
                    inputBuilder.yield(AnalyzerInput(buffer: tail))
                }
            }
            inputBuilder.finish()
        }

        eventsIn.yield(.ready)
    }

    deinit {
        // Safety net for sessions dropped without finish(). The worker tasks
        // capture only locals/continuations (never self), so deinit does run
        // while they are still alive.
        pumpTask?.cancel()
        resultsTask?.cancel()
        feedIn.finish()
        eventsIn.finish()
    }

    /// Thread-safe, ordered, non-blocking; safe to call from any context.
    nonisolated func feed(_ data: Data) {
        feedIn.yield(data)
    }

    /// Ends input, finalizes remaining audio, and completes `events` after the
    /// final transcript has been delivered. Bounded: if the analyzer fails to
    /// finalize within 10 s, the streams are force-finished so consumers never
    /// hang (logged to stderr).
    func finish() async {
        feedIn.finish()
        // The pump always terminates once the feed stream ends (each iteration
        // is a bounded synchronous conversion), so this await is safe.
        _ = await pumpTask?.value

        // Finalize + drain results under a watchdog. The shutdown work runs in
        // a detached task signalling a stream, because directly awaiting its
        // .value in a task group is not cancellable and would defeat the race.
        let analyzer = self.analyzer
        let resultsTask = self.resultsTask
        let (done, doneIn) = AsyncStream<Void>.makeStream()
        let shutdown = Task.detached {
            try? await analyzer.finalizeAndFinishThroughEndOfInput()
            _ = await resultsTask?.value
            doneIn.finish()
        }
        let timedOut = await withTaskGroup(of: Bool.self) { group in
            group.addTask { for await _ in done {}; return false }
            group.addTask {
                try? await Task.sleep(nanoseconds: TranscriberSession.finishTimeout)
                return true
            }
            let first = await group.next() ?? true
            group.cancelAll()
            return first
        }
        if timedOut {
            FileHandle.standardError.write(
                Data("transcriber: finalize timed out after 10s; forcing shutdown\n".utf8))
            shutdown.cancel()
            resultsTask?.cancel()
        }
        eventsIn.finish()
    }
}
