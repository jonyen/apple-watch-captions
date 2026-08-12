import Foundation
import Combine

/// One entry in the transcript list.
public struct TranscriptListItem: Equatable, Identifiable, Sendable {
    public var id: String { name }
    public let name: String
    /// Topic from the summary; absent when the session was never summarized.
    public let title: String?
    /// ISO 8601, as the relay stores it.
    public let startedAt: String
    public let segmentCount: Int
    public let hasSummary: Bool

    public init(name: String, title: String?, startedAt: String,
                segmentCount: Int, hasSummary: Bool) {
        self.name = name
        self.title = title
        self.startedAt = startedAt
        self.segmentCount = segmentCount
        self.hasSummary = hasSummary
    }
}

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

/// A transcript with its summary, as shown on the detail screen.
public struct TranscriptDetail: Equatable, Sendable {
    public let name: String
    /// Raw summary text, including its `Title:` line when present.
    public let summary: String?
    public let segments: [TranscriptSegment]

    public init(name: String, summary: String?, segments: [TranscriptSegment]) {
        self.name = name
        self.summary = summary
        self.segments = segments
    }

    /// Topic parsed off the summary's first line.
    public var title: String? { parsedSummary.title }
    /// Summary without its title line, which the screen shows as a heading.
    public var summaryBody: String? {
        let body = parsedSummary.body
        return body.isEmpty ? nil : body
    }

    private var parsedSummary: (title: String?, body: String) {
        parseSummary(summary ?? "")
    }
}

/// Splits a `Title: …` first line off a summary, mirroring the relay's parser
/// so the watch shows the same title the Notion page carries.
func parseSummary(_ raw: String) -> (title: String?, body: String) {
    let lines = raw.split(separator: "\n", omittingEmptySubsequences: false)
    guard let first = lines.first else { return (nil, raw) }

    let trimmed = first.trimmingCharacters(in: .whitespaces)
    let stripped = trimmed
        .replacingOccurrences(of: "^(\\*\\*|#{1,6}\\s*)?Title:\\*{0,2}",
                              with: "", options: [.regularExpression])
    guard stripped != trimmed else { return (nil, raw) }

    let title = stripped
        .trimmingCharacters(in: CharacterSet(charactersIn: "* "))
        .trimmingCharacters(in: .whitespaces)
    let body = lines.dropFirst()
        .joined(separator: "\n")
        .trimmingCharacters(in: .whitespacesAndNewlines)
    return (title.isEmpty ? nil : title, body)
}

/// A list row: the topic reads first, the date only disambiguates.
public struct TranscriptRow: Equatable, Sendable {
    public let primary: String
    public let secondary: String?

    public init(item: TranscriptListItem, timeZone: TimeZone = .current) {
        let when = Self.format(item.startedAt, timeZone: timeZone)
        if let title = item.title, !title.isEmpty {
            primary = title
            secondary = when
        } else {
            primary = when
            secondary = nil
        }
    }

    /// `Jul 10, 6:05 PM`, or the raw value if it will not parse.
    static func format(_ iso: String, timeZone: TimeZone) -> String {
        guard let date = parseISODate(iso) else { return iso }

        let out = DateFormatter()
        out.locale = Locale(identifier: "en_US_POSIX")
        out.timeZone = timeZone
        out.dateFormat = "MMM d, h:mm a"
        return out.string(from: date)
    }
}

public enum HistoryError: Error, Equatable {
    case message(String)

    public var text: String {
        switch self {
        case .message(let m): return m
        }
    }
}

/// Reads and removes stored transcripts on the relay.
public protocol HistoryClient: Sendable {
    func list() async throws -> [TranscriptListItem]
    func detail(name: String) async throws -> TranscriptDetail
    func delete(name: String) async throws
}

public enum LoadState: Equatable, Sendable {
    case idle
    case loading
    case loaded
    case failed(String)
}

/// Observable transcript history. UI state only; mutate on the main actor.
@MainActor
public final class HistoryStore: ObservableObject {
    @Published public private(set) var items: [TranscriptListItem] = []
    @Published public private(set) var listState: LoadState = .idle
    @Published public private(set) var detail: TranscriptDetail?
    @Published public private(set) var detailState: LoadState = .idle
    /// Set when a delete failed and its row was put back; the list alerts on it.
    @Published public private(set) var deleteError: String?

    private let client: HistoryClient

    public init(client: HistoryClient) {
        self.client = client
    }

    /// Forget a transcript. The row leaves the list before the relay is asked,
    /// so it clears out from under the swipe; a failure puts it back where it
    /// was and raises `deleteError`.
    public func delete(_ item: TranscriptListItem) async {
        guard let index = items.firstIndex(of: item) else { return }
        items.remove(at: index)
        do {
            try await client.delete(name: item.name)
        } catch {
            items.insert(item, at: min(index, items.count))
            deleteError = message(from: error)
        }
    }

    public func clearDeleteError() {
        deleteError = nil
    }

    public func load() async {
        listState = .loading
        do {
            items = try await client.list()
            listState = .loaded
        } catch {
            items = []
            listState = .failed(message(from: error))
        }
    }

    public func loadDetail(name: String) async {
        detailState = .loading
        detail = nil
        do {
            detail = try await client.detail(name: name)
            detailState = .loaded
        } catch {
            detailState = .failed(message(from: error))
        }
    }

    private func message(from error: Error) -> String {
        (error as? HistoryError)?.text ?? error.localizedDescription
    }
}

// MARK: - Decoding

/// Decode `GET /v1/transcripts`. Entries without a name are skipped rather than
/// failing the whole list — one bad row should not empty the screen.
public func decodeTranscriptList(_ json: [String: Any]) throws -> [TranscriptListItem] {
    guard let entries = json["transcripts"] as? [[String: Any]] else {
        throw HistoryError.message("Unexpected response")
    }
    return entries.compactMap { entry in
        guard let name = entry["name"] as? String else { return nil }
        return TranscriptListItem(
            name: name,
            title: entry["title"] as? String,
            startedAt: entry["startedAt"] as? String ?? "",
            segmentCount: entry["segmentCount"] as? Int ?? 0,
            hasSummary: entry["hasSummary"] as? Bool ?? false)
    }
}

public extension String {
    /// Parse a stored summary as markdown, falling back to the literal text.
    ///
    /// Summaries are written as markdown by the relay: an overview paragraph,
    /// `## ` section headings, and `- ` bullets. SwiftUI's `Text(String)`
    /// overload does not parse any of it, so headings and bullets would
    /// otherwise show their syntax characters on the wrist.
    ///
    /// Neither of `AttributedString(markdown:)`'s syntax options covers both
    /// needs at once: `.full` interprets block syntax but collapses paragraph
    /// and line breaks entirely, running every section together; `.inlineOnly*`
    /// preserves that structure but leaves block syntax like `## ` and `- `
    /// untouched. So heading and bullet markers are stripped by hand first,
    /// then the rest is parsed inline-only to keep the line breaks that make
    /// a multi-section summary readable on a small screen.
    var asSummaryMarkdown: AttributedString {
        let blockSyntaxStripped = split(separator: "\n", omittingEmptySubsequences: false)
            .map(Self.strippingBlockMarkers)
            .joined(separator: "\n")
        return (try? AttributedString(
            markdown: blockSyntaxStripped,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )) ?? AttributedString(self)
    }

    /// Strips one line's leading `## ` heading marker or `- ` bullet marker,
    /// replacing a bullet with a plain dot since inline-only parsing does not
    /// render markdown lists.
    private static func strippingBlockMarkers(from line: Substring) -> String {
        var rest = line
        var hashCount = 0
        while rest.first == "#" && hashCount < 6 {
            rest = rest.dropFirst()
            hashCount += 1
        }
        if hashCount > 0, rest.first == " " {
            return String(rest.dropFirst())
        }
        if line.hasPrefix("- ") {
            return "• " + line.dropFirst(2)
        }
        return String(line)
    }
}

/// Decode `GET /v1/transcripts/<name>`.
public func decodeTranscriptDetail(_ json: [String: Any], name: String) -> TranscriptDetail {
    let segments = (json["segments"] as? [[String: Any]] ?? []).map { segment in
        TranscriptSegment(text: segment["text"] as? String ?? "",
                          channel: segment["channel"] as? Int,
                          at: segment["at"] as? String)
    }
    return TranscriptDetail(name: name, summary: json["summary"] as? String, segments: segments)
}
