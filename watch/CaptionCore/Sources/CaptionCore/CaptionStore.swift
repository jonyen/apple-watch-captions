import Foundation
import Combine

/// The screen the app shows, derived from session progress.
public enum CaptionState: Equatable {
    case connecting
    case listening
    case error(String)
}

/// One finalized caption line, tagged with its capture channel when known.
public struct CaptionLine: Equatable, Identifiable {
    public let id = UUID()
    public let text: String
    public let channel: Int?
    public init(text: String, channel: Int?) {
        self.text = text
        self.channel = channel
    }
    public static func == (lhs: CaptionLine, rhs: CaptionLine) -> Bool {
        lhs.text == rhs.text && lhs.channel == rhs.channel
    }
}

/// Observable transcript + connection state. UI state only; mutate on the main actor.
@MainActor
public final class CaptionStore: ObservableObject {
    @Published public private(set) var lines: [CaptionLine] = []
    @Published public private(set) var partials: [Int: String] = [:]
    @Published public private(set) var state: CaptionState = .connecting

    /// Mono convenience: the in-progress line for the (only) channel.
    public var partial: String { partials[0] ?? "" }

    public init() {}

    /// Fold a relay message into the transcript/state.
    public func apply(_ message: ServerMessage) {
        switch message {
        case .ready:
            state = .listening
        case .caption(let text, let isFinal, let channel):
            let key = channel ?? 0
            if isFinal {
                if !text.isEmpty { lines.append(CaptionLine(text: text, channel: channel)) }
                partials[key] = ""
            } else {
                partials[key] = text
            }
        case .error(let message):
            state = .error(message)
        }
    }

    /// Clear the transcript and return to connecting (called at session start).
    public func reset() {
        lines = []
        partials = [:]
        state = .connecting
    }

    /// Force an error state (e.g. connection lost, permission denied).
    public func setError(_ message: String) {
        state = .error(message)
    }
}
