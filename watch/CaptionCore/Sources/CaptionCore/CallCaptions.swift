import Foundation

/// Why the call being captioned stopped.
public enum CallEndReason: String, Equatable, Sendable {
    /// The caller hung up.
    case ended
    /// The audio stream died while the call was still up. Captions stopped;
    /// the call may not have.
    case streamLost = "stream_lost"
}

/// One answer from `GET /v1/call`: whether a call is live, and what has been
/// said since the sequence number asked for.
public struct CallUpdate: Equatable, Sendable {
    public let active: Bool
    public let reason: CallEndReason?
    public let events: [ServerMessage]
    public let seq: Int

    public init(active: Bool, reason: CallEndReason?, events: [ServerMessage], seq: Int) {
        self.active = active
        self.reason = reason
        self.events = events
        self.seq = seq
    }
}

/// Reads the call the relay is currently captioning.
public protocol CallClient: Sendable {
    func poll(since: Int) async throws -> CallUpdate
}

/// Decode `GET /v1/call`. Anything unrecognized reads as "no call": a body we
/// cannot understand must never present as a live conversation.
public func decodeCallUpdate(_ json: [String: Any]) -> CallUpdate {
    let events = (json["events"] as? [[String: Any]] ?? []).compactMap(decodeCallEvent)
    return CallUpdate(
        active: json["active"] as? Bool ?? false,
        reason: (json["reason"] as? String).flatMap(CallEndReason.init(rawValue:)),
        events: events,
        seq: json["seq"] as? Int ?? 0)
}

private func decodeCallEvent(_ event: [String: Any]) -> ServerMessage? {
    switch event["type"] as? String {
    case "ready":
        return .ready
    case "caption":
        return .caption(
            text: event["text"] as? String ?? "",
            isFinal: event["isFinal"] as? Bool ?? false,
            channel: event["channel"] as? Int)
    case "error":
        return .error(message: event["message"] as? String ?? "error")
    default:
        return nil
    }
}
