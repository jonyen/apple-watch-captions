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
    @Published public private(set) var lines: [String] = []
    @Published public private(set) var partial: String = ""
    @Published public private(set) var state: CaptionState = .connecting

    public init() {}

    /// Fold a relay message into the transcript/state.
    public func apply(_ message: ServerMessage) {
        switch message {
        case .ready:
            state = .listening
        case .caption(let text, let isFinal):
            if isFinal {
                if !text.isEmpty { lines.append(text) }
                partial = ""
            } else {
                partial = text
            }
        case .error(let message):
            state = .error(message)
        }
    }

    /// Clear the transcript and return to connecting (called at session start).
    public func reset() {
        lines = []
        partial = ""
        state = .connecting
    }

    /// Force an error state (e.g. connection lost, permission denied).
    public func setError(_ message: String) {
        state = .error(message)
    }
}
