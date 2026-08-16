import Foundation

/// A run of speech shown as one wrapping block of text. Speech-to-text
/// finalizes at utterance boundaries, which is far more often than a reader
/// wants a line break, so finals are joined until something says otherwise.
public struct CaptionParagraph: Identifiable, Equatable {
    public let id: UUID
    public let channel: Int?
    public var text: String

    public init(id: UUID = UUID(), channel: Int?, text: String) {
        self.id = id
        self.channel = channel
        self.text = text
    }
}

/// Silence long enough to start a new paragraph while captions are live.
///
/// Measured as the absence of *any* caption message. Partials arrive about once
/// per relay poll while someone is speaking, so a gap this long means nobody is.
/// The gap between two finals is not usable for this: it contains all of the
/// next utterance's speech, so a long sentence looks exactly like a pause.
public let livePauseThreshold: TimeInterval = 3

/// Gap between two stored finals' timestamps that starts a new paragraph.
///
/// Higher than the live threshold because a stored gap *is* the weaker signal
/// described above — all we have after the fact — so only an unambiguous one
/// counts. Finals land every few seconds during continuous speech; eight is
/// well clear of that.
public let storedPauseThreshold: TimeInterval = 8

/// Group stored segments into paragraphs, breaking on a long gap or a change of
/// speaker.
public func buildParagraphs(
    from segments: [TranscriptSegment],
    pauseThreshold: TimeInterval = storedPauseThreshold
) -> [CaptionParagraph] {
    var paragraphs: [CaptionParagraph] = []
    var previousAt: Date?

    for segment in segments where !segment.text.isEmpty {
        let at = segment.at.flatMap(parseISODate)
        var paused = false
        if let at, let previousAt {
            paused = at.timeIntervalSince(previousAt) >= pauseThreshold
        }
        append(segment.text, channel: segment.channel,
               startingParagraph: paused, to: &paragraphs)
        // Keep the last usable time, so one undated segment does not blind the
        // next comparison.
        previousAt = at ?? previousAt
    }
    return paragraphs
}

/// The one join rule, shared by the stored and the live path: continue the last
/// paragraph unless a break is called for or the speaker changed.
func append(_ text: String, channel: Int?, startingParagraph: Bool,
            to paragraphs: inout [CaptionParagraph]) {
    if !startingParagraph, let last = paragraphs.last, last.channel == channel {
        paragraphs[paragraphs.count - 1].text += " " + text
    } else {
        paragraphs.append(CaptionParagraph(channel: channel, text: text))
    }
}

/// Parse an ISO 8601 timestamp with or without fractional seconds. The relay
/// writes both shapes.
public func parseISODate(_ iso: String) -> Date? {
    let parser = ISO8601DateFormatter()
    parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = parser.date(from: iso) { return date }
    parser.formatOptions = [.withInternetDateTime]
    return parser.date(from: iso)
}
