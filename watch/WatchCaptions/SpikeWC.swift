import Foundation
import WatchConnectivity

// THROWAWAY device spike (roaming-transcriber task 1): measures
// WatchConnectivity throughput/latency by streaming 240 synthetic
// "PCM" chunks (8,000 bytes / 0.25 s each, i.e. 32 KB/s) from the watch
// to the phone via sendMessageData and timing the echoed reply.
//
// Gated on a file marker (Documents/spike-wc) so it never runs in
// normal use — the controller writes the marker into the app
// container before launching. Deleted once the go/no-go decision in
// task-1-brief.md is made; do not build on top of this.
enum SpikeWC {
    static let markerName = "spike-wc"
    static let resultsName = "spike-wc-results.txt"

    static let chunkCount = 240
    static let chunkBytes = 8_000
    static let chunkInterval: TimeInterval = 0.25
    static let dropTimeout: TimeInterval = 5.0

    /// Call once from the app's init. No-op unless the marker file is present.
    static func runIfRequested() {
        let fm = FileManager.default
        // watchOS may not have created the app's Documents dir yet — make sure
        // it exists before we probe for the marker or try to write results.
        guard let docs = fm.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
        try? fm.createDirectory(at: docs, withIntermediateDirectories: true)

        let marker = docs.appendingPathComponent(markerName)
        guard fm.fileExists(atPath: marker.path) else { return }
        guard WCSession.isSupported() else { return }

        let runner = Runner(docsURL: docs, tmpURL: fm.temporaryDirectory)
        Holder.runner = runner
        runner.start()
    }

    /// Keeps the runner (and its WCSessionDelegate) alive for the process
    /// lifetime — WCSession.delegate does not retain its delegate.
    private enum Holder {
        static var runner: Runner?
    }

    final class Runner: NSObject, WCSessionDelegate {
        private let docsURL: URL
        private let tmpURL: URL
        private let queue = DispatchQueue(label: "spike-wc.watch.runner")

        private var lines: [String] = []
        private var pendingSentAt: [UInt32: TimeInterval] = [:]
        private var rtts: [Int] = []
        private var sent = 0
        private var replied = 0
        private var dropped = 0
        private var totalBytes = 0
        private var startTime: Date?

        init(docsURL: URL, tmpURL: URL) {
            self.docsURL = docsURL
            self.tmpURL = tmpURL
        }

        func start() {
            let session = WCSession.default
            session.delegate = self
            session.activate()
        }

        // MARK: - WCSessionDelegate

        func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
            queue.async { [weak self] in
                if let error {
                    self?.appendLine("activation error=\(error.localizedDescription)")
                }
                self?.waitForReachable()
            }
        }

        // MARK: - Reachability wait

        private func waitForReachable(attempt: Int = 0) {
            let session = WCSession.default
            guard session.isReachable else {
                appendLine("waiting reachable=false attempt=\(attempt)")
                queue.asyncAfter(deadline: .now() + 1.0) { [weak self] in
                    self?.waitForReachable(attempt: attempt + 1)
                }
                return
            }
            appendLine("waiting reachable=true attempt=\(attempt)")
            beginStreaming()
        }

        // MARK: - Streaming

        private func beginStreaming() {
            guard startTime == nil else { return }
            startTime = Date()
            sendNext(seq: 0)
        }

        private func sendNext(seq: UInt32) {
            guard seq < UInt32(SpikeWC.chunkCount) else {
                // Give any in-flight replies/timeouts time to settle, then
                // write a final summary.
                queue.asyncAfter(deadline: .now() + SpikeWC.dropTimeout + 1.0) { [weak self] in
                    self?.writeResults()
                }
                return
            }

            let sentAt = Date().timeIntervalSince1970
            let chunk = SpikeWC.makeChunk(seq: seq, sentAt: sentAt)
            pendingSentAt[seq] = sentAt
            sent += 1
            totalBytes += chunk.count

            WCSession.default.sendMessageData(chunk, replyHandler: { [weak self] replyData in
                self?.queue.async { self?.handleReply(seq: seq, replyData: replyData) }
            }, errorHandler: { [weak self] error in
                self?.queue.async { self?.handleDrop(seq: seq, reason: "error:\(error.localizedDescription)") }
            })

            queue.asyncAfter(deadline: .now() + SpikeWC.dropTimeout) { [weak self] in
                self?.handleDrop(seq: seq, reason: "timeout")
            }

            queue.asyncAfter(deadline: .now() + SpikeWC.chunkInterval) { [weak self] in
                self?.sendNext(seq: seq + 1)
            }
        }

        private func handleReply(seq: UInt32, replyData: Data) {
            guard let sentAt = pendingSentAt.removeValue(forKey: seq) else {
                return // already timed out and counted as dropped
            }
            let rttMs = Int((Date().timeIntervalSince1970 - sentAt) * 1000)
            replied += 1
            rtts.append(rttMs)
            appendLine("chunk seq=\(seq) rtt_ms=\(rttMs)")
        }

        private func handleDrop(seq: UInt32, reason: String) {
            guard pendingSentAt.removeValue(forKey: seq) != nil else {
                return // already got its reply
            }
            dropped += 1
            appendLine("chunk seq=\(seq) rtt_ms=-1") // -1 = dropped (reason: \(reason))
        }

        // MARK: - Results file

        private func appendLine(_ line: String) {
            lines.append(line)
            writeResults()
        }

        private func writeResults() {
            let elapsed = startTime.map { Date().timeIntervalSince($0) } ?? 0
            // Named throughput_bps per the spec, but computed as bytes/sec to
            // match the go/no-go gate, which is stated in KB/s.
            let throughput = elapsed > 0 ? Int(Double(totalBytes) / elapsed) : 0
            let median = SpikeWC.median(of: rtts)
            let summary = "SUMMARY sent=\(sent) replied=\(replied) dropped=\(dropped) bytes=\(totalBytes) elapsed_s=\(String(format: "%.2f", elapsed)) throughput_bps=\(throughput) median_rtt_ms=\(median)"
            let content = (lines + [summary]).joined(separator: "\n") + "\n"
            SpikeWC.write(content: content, to: docsURL.appendingPathComponent(SpikeWC.resultsName))
            SpikeWC.write(content: content, to: tmpURL.appendingPathComponent(SpikeWC.resultsName))
        }
    }

    // MARK: - Wire format

    /// Chunk layout: 4-byte big-endian seq, 8-byte big-endian bit pattern of
    /// a Double send-time, then zero-filled payload out to chunkBytes total.
    static func makeChunk(seq: UInt32, sentAt: TimeInterval) -> Data {
        var data = Data(capacity: chunkBytes)
        var seqBE = seq.bigEndian
        withUnsafeBytes(of: &seqBE) { data.append(contentsOf: $0) }
        var sentAtBE = sentAt.bitPattern.bigEndian
        withUnsafeBytes(of: &sentAtBE) { data.append(contentsOf: $0) }
        let payloadLen = max(0, chunkBytes - data.count)
        data.append(Data(repeating: 0xA5, count: payloadLen))
        return data
    }

    static func median(of values: [Int]) -> Int {
        guard !values.isEmpty else { return -1 }
        let sorted = values.sorted()
        let mid = sorted.count / 2
        if sorted.count % 2 == 0 {
            return (sorted[mid - 1] + sorted[mid]) / 2
        }
        return sorted[mid]
    }

    static func write(content: String, to url: URL) {
        try? content.write(to: url, atomically: true, encoding: .utf8)
    }
}
