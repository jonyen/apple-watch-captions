import Foundation

public struct TranscriptSegment: Equatable, Identifiable, Sendable {
    public let id = UUID()
    public let text: String
    public let channel: Int?
    /// ISO 8601 time the final caption arrived, as the relay stores it. Absent
    /// on rows written before the relay recorded it, and in tests that do not
    /// care about timing.
    public let at: String?

    public init(text: String, channel: Int?, at: String? = nil) {
        self.text = text
        self.channel = channel
        self.at = at
    }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.text == rhs.text && lhs.channel == rhs.channel && lhs.at == rhs.at
    }
}
