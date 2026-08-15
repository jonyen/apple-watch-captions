import Foundation
import Combine

/// The screen the app shows, derived from session progress.
public enum CaptionState: Equatable {
    case connecting
    case listening
    case error(String)
}

/// Observable transcript + connection state. UI state only; mutate on the main actor.
@MainActor
public final class CaptionStore: ObservableObject {
    @Published public private(set) var paragraphs: [CaptionParagraph] = []
    @Published public private(set) var partials: [Int: String] = [:]
    @Published public private(set) var state: CaptionState = .connecting

    /// Mono convenience: the in-progress line for the (only) channel.
    public var partial: String { partials[0] ?? "" }

    /// Whether anything has been said yet, finalized or in progress. Lets a
    /// screen tell "waiting for audio" apart from "audio is arriving" without
    /// reaching into two collections to ask.
    public var hasCaptions: Bool { !paragraphs.isEmpty || !partial.isEmpty }

    private let now: () -> Date
    private let pauseThreshold: TimeInterval
    /// Arrival time of the most recent caption of any kind.
    private var lastCaptionAt: Date?
    /// A silence was observed; the next final starts a paragraph.
    private var pendingBreak = false

    /// `now` is injectable so pause detection is testable.
    public init(now: @escaping () -> Date = Date.init,
                pauseThreshold: TimeInterval = livePauseThreshold) {
        self.now = now
        self.pauseThreshold = pauseThreshold
    }

    /// Fold a relay message into the transcript/state.
    public func apply(_ message: ServerMessage) {
        switch message {
        case .ready:
            state = .listening
        case .caption(let text, let isFinal, let channel):
            noteCaptionArrival()
            let key = channel ?? 0
            if isFinal {
                if !text.isEmpty {
                    append(text, channel: channel,
                           startingParagraph: pendingBreak, to: &paragraphs)
                    pendingBreak = false
                }
                partials[key] = ""
            } else {
                partials[key] = text
            }
        case .error(let message):
            state = .error(message)
        }
    }

    /// A caption arriving after a silence means speech resumed. The relay only
    /// forwards captions with text, so any message at all is evidence someone is
    /// talking — and a long enough gap between them is evidence nobody was.
    /// Recorded rather than applied, because it is the partial reopening speech
    /// that sees the gap, and the final it belongs to arrives later.
    private func noteCaptionArrival() {
        let arrival = now()
        defer { lastCaptionAt = arrival }
        guard let last = lastCaptionAt else { return }
        if arrival.timeIntervalSince(last) >= pauseThreshold { pendingBreak = true }
    }

    /// Put a previous session's transcript ahead of this one's captions, so a
    /// resumed conversation reads as one. Safe either side of the first live
    /// caption: the restore and the session race, and neither order should lose.
    public func prepend(_ segments: [TranscriptSegment]) {
        let restored = buildParagraphs(from: segments)
        guard !restored.isEmpty else { return }
        let hadCaptions = !paragraphs.isEmpty
        paragraphs.insert(contentsOf: restored, at: 0)
        // With nothing live yet, the next final would run on from the restored
        // tail; a session boundary is a long pause by definition. If captions
        // are already here they are a separate paragraph and need no help —
        // and forcing a break would split a sentence mid-flow.
        if !hadCaptions { pendingBreak = true }
    }

    /// Clear the transcript and return to connecting (called at session start).
    public func reset() {
        paragraphs = []
        partials = [:]
        state = .connecting
        lastCaptionAt = nil
        pendingBreak = false
    }

    /// Force an error state (e.g. connection lost, permission denied).
    public func setError(_ message: String) {
        state = .error(message)
    }
}
