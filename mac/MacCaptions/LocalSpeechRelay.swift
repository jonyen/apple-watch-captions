import Foundation
import AVFoundation
import Speech
import CaptionCore

/// Apple on-device captioning presented as a `Relay`, so `SessionController`
/// drives it exactly like a relay-backed provider: `connect()` asks for
/// speech-recognition permission and emits `.ready`; `send(_:)` takes the
/// same interleaved stereo PCM the relay gets and feeds one recognizer per
/// channel; captions come back as `.caption` messages. No backend involved.
final class LocalSpeechRelay: NSObject, Relay {
    var onMessage: (@MainActor (ServerMessage) -> Void)?
    var onClose: (@MainActor () -> Void)?

    private let queue = DispatchQueue(label: "localspeech")
    private var channels: [ChannelRecognizer] = []
    private var tickTimer: DispatchSourceTimer?
    private var stopped = false

    func connect() {
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            guard let self else { return }
            self.queue.async {
                guard !self.stopped else { return }
                guard status == .authorized else {
                    self.emit(.error(message:
                        "Speech recognition access is off. Enable it in Settings › Privacy."))
                    return
                }
                let emitCaption: (String, Bool, Int) -> Void = { [weak self] text, isFinal, channel in
                    self?.emit(.caption(text: text, isFinal: isFinal, channel: channel))
                }
                let made = [0, 1].compactMap { channel in
                    ChannelRecognizer(channel: channel, queue: self.queue, emit: emitCaption)
                }
                guard made.count == 2 else {
                    self.emit(.error(message: "Apple speech recognition is unavailable on this Mac."))
                    return
                }
                self.channels = made
                self.startTick()
                self.emit(.ready)
            }
        }
    }

    func send(_ audio: Data) {
        queue.async { [weak self] in
            guard let self, !self.stopped, !self.channels.isEmpty else { return }
            let (mic, system) = Self.deinterleave(audio)
            self.channels[0].append(mic)
            self.channels[1].append(system)
        }
    }

    func close() {
        queue.async { [weak self] in
            guard let self else { return }
            self.stopped = true
            self.tickTimer?.cancel()
            self.tickTimer = nil
            for channel in self.channels { channel.finish() }
            self.channels = []
        }
    }

    /// Utterance segmentation: SFSpeech mostly streams ever-growing partials,
    /// so a partial that has stopped changing for a moment is finalized and
    /// the recognizer restarted for the next utterance.
    private func startTick() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 1, repeating: 1)
        timer.setEventHandler { [weak self] in
            guard let self, !self.stopped else { return }
            for channel in self.channels { channel.tick() }
        }
        timer.resume()
        tickTimer = timer
    }

    private func emit(_ message: ServerMessage) {
        guard let onMessage else { return }
        Task { @MainActor in onMessage(message) }
    }

    /// Split interleaved stereo Int16 LE frames (ch0 = mic, ch1 = system).
    private static func deinterleave(_ data: Data) -> ([Int16], [Int16]) {
        let frames = data.count / 4
        guard frames > 0 else { return ([], []) }
        var mic = [Int16](repeating: 0, count: frames)
        var system = [Int16](repeating: 0, count: frames)
        data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            let samples = raw.bindMemory(to: Int16.self)
            for f in 0..<frames {
                mic[f] = Int16(littleEndian: samples[f * 2])
                system[f] = Int16(littleEndian: samples[f * 2 + 1])
            }
        }
        return (mic, system)
    }
}

/// One channel's recognition pipeline. All calls happen on the owner's queue.
private final class ChannelRecognizer {
    /// A partial unchanged for this long is treated as a finished utterance.
    private static let utteranceStability: TimeInterval = 2

    private let channel: Int
    private let queue: DispatchQueue
    private let emit: (String, Bool, Int) -> Void
    private let recognizer: SFSpeechRecognizer
    private let format = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!

    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    /// Bumped whenever the current task is abandoned; stale results are dropped.
    private var generation = 0
    private var partial = ""
    private var lastChange = Date()

    init?(channel: Int, queue: DispatchQueue, emit: @escaping (String, Bool, Int) -> Void) {
        guard let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else { return nil }
        self.channel = channel
        self.queue = queue
        self.emit = emit
        self.recognizer = recognizer
    }

    func append(_ samples: [Int16]) {
        guard !samples.isEmpty, let buffer = makeBuffer(samples) else { return }
        activeRequest().append(buffer)
    }

    /// Finalize a partial that has stopped changing (see utteranceStability).
    func tick() {
        guard !partial.isEmpty,
              Date().timeIntervalSince(lastChange) >= Self.utteranceStability else { return }
        finalizeUtterance()
    }

    func finish() {
        if !partial.isEmpty { emit(partial, true, channel) }
        abandonTask()
    }

    private func activeRequest() -> SFSpeechAudioBufferRecognitionRequest {
        if let request { return request }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        if recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }
        self.request = request

        let generation = self.generation
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            self.queue.async {
                guard generation == self.generation else { return }
                if let result {
                    let text = result.bestTranscription.formattedString
                    if text != self.partial, !text.isEmpty {
                        self.partial = text
                        self.lastChange = Date()
                        self.emit(text, false, self.channel)
                    }
                    if result.isFinal { self.finalizeUtterance() }
                } else if error != nil {
                    // Recognizer gave up (silence timeout, cancellation, …):
                    // keep whatever was heard and restart on the next audio.
                    if !self.partial.isEmpty { self.finalizeUtterance() } else { self.abandonTask() }
                }
            }
        }
        return request
    }

    private func finalizeUtterance() {
        if !partial.isEmpty {
            emit(partial, true, channel)
            partial = ""
        }
        abandonTask()
    }

    private func abandonTask() {
        generation += 1
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
        partial = ""
    }

    private func makeBuffer(_ samples: [Int16]) -> AVAudioPCMBuffer? {
        guard let buffer = AVAudioPCMBuffer(
            pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)) else { return nil }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        guard let dest = buffer.int16ChannelData else { return nil }
        samples.withUnsafeBufferPointer { src in
            dest[0].update(from: src.baseAddress!, count: samples.count)
        }
        return buffer
    }
}
