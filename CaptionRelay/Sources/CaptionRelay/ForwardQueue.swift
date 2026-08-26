import Foundation

/// Disk-format-owning queue of kept-session lines awaiting delivery.
///
/// Storage-agnostic: this type is pure logic over an in-memory list of
/// entries. Callers (`ForwardingStore` on the phone) own reading/writing the
/// JSON file and the actual network replay; tests exercise this type purely
/// in memory.
public struct ForwardQueue: Codable, Equatable {
    public struct Entry: Codable, Equatable {
        public let sessionId: String
        public let token: String
        public var lines: [PhoneWire.Caption]
        public var finished: Bool
    }

    public private(set) var entries: [Entry]

    public init() {
        entries = []
    }

    /// Append one line to the session's entry, creating it (in append order)
    /// if this is the first line seen for `sessionId`.
    public mutating func append(sessionId: String, token: String, caption: PhoneWire.Caption) {
        if let index = entries.firstIndex(where: { $0.sessionId == sessionId }) {
            entries[index].lines.append(caption)
        } else {
            entries.append(Entry(sessionId: sessionId, token: token, lines: [caption], finished: false))
        }
    }

    /// Mark the session's entry finished, creating an empty finished entry if
    /// no lines were ever appended (e.g. a kept session that produced no
    /// final captions before the watch stopped).
    public mutating func markFinished(sessionId: String, token: String) {
        if let index = entries.firstIndex(where: { $0.sessionId == sessionId }) {
            entries[index].finished = true
        } else {
            entries.append(Entry(sessionId: sessionId, token: token, lines: [], finished: true))
        }
    }

    /// The first entry ready to deliver: a finished entry (regardless of how
    /// many lines it holds — a session that just ended must not wait for a
    /// full batch) takes priority over one merely at or above
    /// `batchThreshold`. `nil` when nothing qualifies.
    public func nextDeliverable(batchThreshold: Int) -> Entry? {
        if let finished = entries.first(where: { $0.finished }) {
            return finished
        }
        return entries.first(where: { $0.lines.count >= batchThreshold })
    }

    /// Remove the lines a successful replay just delivered. `lineCount` is
    /// exactly how many leading lines were sent — never assumed to be "all of
    /// them" — so a line appended after the replay started (and thus not
    /// part of what was sent) survives. `finished` is the entry's finished
    /// flag as of the replay (delivering `entry.finished` back unchanged);
    /// once the entry is both finished and empty, it is dropped entirely —
    /// its token included, so nothing about a delivered session lingers.
    public mutating func delivered(sessionId: String, lineCount: Int, finished: Bool) {
        guard let index = entries.firstIndex(where: { $0.sessionId == sessionId }) else { return }
        entries[index].lines.removeFirst(min(lineCount, entries[index].lines.count))
        entries[index].finished = finished
        if entries[index].finished, entries[index].lines.isEmpty {
            entries.remove(at: index)
        }
    }
}
