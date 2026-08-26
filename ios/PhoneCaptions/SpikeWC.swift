import Foundation
import WatchConnectivity

// THROWAWAY device spike (roaming-transcriber task 1): mirror-image of
// watch/WatchCaptions/SpikeWC.swift. Replies to each WatchConnectivity
// message with {seq, receivedAt} as fast as possible and keeps a running
// count of bytes/messages received, so the watch side can measure
// end-to-end round trip time and throughput.
//
// Gated on a file marker (Documents/spike-wc) so it never runs in normal
// use — the controller writes the marker into the app container before
// launching. Deleted once the go/no-go decision in task-1-brief.md is made;
// do not build on top of this.
enum SpikeWC {
    static let markerName = "spike-wc"
    static let resultsName = "spike-wc-phone.txt"

    /// Call once from the app's init. No-op unless the marker file is present.
    static func runIfRequested() {
        let fm = FileManager.default
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
        private let queue = DispatchQueue(label: "spike-wc.phone.runner")

        private var lines: [String] = []
        private var received = 0
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
                } else {
                    self?.appendLine("activation state=\(activationState.rawValue)")
                }
            }
        }

        func sessionDidBecomeInactive(_ session: WCSession) {}

        func sessionDidDeactivate(_ session: WCSession) {
            // Re-activate for a possible watch re-pair, per Apple's guidance.
            WCSession.default.activate()
        }

        func session(_ session: WCSession, didReceiveMessageData messageData: Data, replyHandler: @escaping (Data) -> Void) {
            let receivedAt = Date().timeIntervalSince1970
            let seq = SpikeWC.decodeSeq(messageData)
            queue.async { [weak self] in
                self?.handleReceived(seq: seq, byteCount: messageData.count)
            }
            replyHandler(SpikeWC.makeReply(seq: seq, receivedAt: receivedAt))
        }

        // MARK: - Bookkeeping

        private func handleReceived(seq: UInt32?, byteCount: Int) {
            if startTime == nil { startTime = Date() }
            received += 1
            totalBytes += byteCount
            appendLine("chunk seq=\(seq.map(String.init) ?? "?") bytes=\(byteCount)")
        }

        private func appendLine(_ line: String) {
            lines.append(line)
            writeResults()
        }

        private func writeResults() {
            let elapsed = startTime.map { Date().timeIntervalSince($0) } ?? 0
            let throughput = elapsed > 0 ? Int(Double(totalBytes) / elapsed) : 0
            let summary = "SUMMARY received=\(received) bytes=\(totalBytes) elapsed_s=\(String(format: "%.2f", elapsed)) throughput_bps=\(throughput)"
            let content = (lines + [summary]).joined(separator: "\n") + "\n"
            SpikeWC.write(content: content, to: docsURL.appendingPathComponent(SpikeWC.resultsName))
            SpikeWC.write(content: content, to: tmpURL.appendingPathComponent(SpikeWC.resultsName))
        }
    }

    // MARK: - Wire format
    // Matches watch/WatchCaptions/SpikeWC.swift's chunk layout: 4-byte
    // big-endian seq, 8-byte big-endian bit pattern of a Double send-time,
    // then a zero-filled payload. The reply mirrors {seq, receivedAt} back
    // in the same 12-byte layout.

    static func decodeSeq(_ data: Data) -> UInt32? {
        guard data.count >= 4 else { return nil }
        return data.withUnsafeBytes { ptr in
            UInt32(bigEndian: ptr.loadUnaligned(fromByteOffset: 0, as: UInt32.self))
        }
    }

    static func makeReply(seq: UInt32?, receivedAt: TimeInterval) -> Data {
        var reply = Data(capacity: 12)
        var seqBE = (seq ?? 0).bigEndian
        withUnsafeBytes(of: &seqBE) { reply.append(contentsOf: $0) }
        var receivedAtBE = receivedAt.bitPattern.bigEndian
        withUnsafeBytes(of: &receivedAtBE) { reply.append(contentsOf: $0) }
        return reply
    }

    static func write(content: String, to url: URL) {
        try? content.write(to: url, atomically: true, encoding: .utf8)
    }
}
