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

        resultsTask = Task { [eventsIn] in
            do {
                for try await result in transcriber.results {
                    eventsIn.yield(.transcript(text: String(result.text.characters),
                                               isFinal: result.isFinal))
                }
            } catch {
                eventsIn.yield(.error(String(describing: error)))
            }
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

        try await analyzer.start(inputSequence: inputStream)
        eventsIn.yield(.ready)
    }

    /// Thread-safe, ordered, non-blocking; safe to call from any context.
    nonisolated func feed(_ data: Data) {
        feedIn.yield(data)
    }

    /// Ends input, finalizes remaining audio, and completes `events` after the
    /// final transcript has been delivered.
    func finish() async {
        feedIn.finish()
        _ = await pumpTask?.value
        try? await analyzer.finalizeAndFinishThroughEndOfInput()
        _ = await resultsTask?.value
        eventsIn.finish()
    }
}
