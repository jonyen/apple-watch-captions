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

/// Reads a live call onto the screen.
///
/// Deliberately not `SessionController`: that orchestrates permission,
/// connection, and microphone capture, and a call needs none of them. The audio
/// is Twilio's, so this never touches the mic or the audio session — there is
/// nothing here to contend with the phone call itself.
@MainActor
public final class CallCaptions: ObservableObject {
    /// Set once the call is over, with why. Nil while it is live.
    @Published public private(set) var ended: CallEndReason?

    public static let pollInterval: TimeInterval = 1

    private let client: CallClient
    private let store: CaptionStore
    private var seq = 0
    /// A call was seen live. Until then an inactive answer just means the relay
    /// has not noticed the call yet, not that it is over.
    private var wasActive = false
    private var task: Task<Void, Never>?

    public init(client: CallClient, store: CaptionStore) {
        self.client = client
        self.store = store
    }

    /// Begin reading. Safe to call again; the previous loop is replaced.
    public func start() {
        store.reset()
        seq = 0
        wasActive = false
        ended = nil
        task?.cancel()
        task = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                guard await self.poll() else { return }
                try? await Task.sleep(
                    nanoseconds: UInt64(Self.pollInterval * 1_000_000_000))
            }
        }
    }

    public func stop() {
        task?.cancel()
        task = nil
    }

    /// One poll. False when the call is over and polling should stop. A failed
    /// request keeps the loop alive — a watch out of range is not an answer.
    @discardableResult
    public func poll() async -> Bool {
        guard let update = try? await client.poll(since: seq) else { return true }
        seq = max(seq, update.seq)
        for event in update.events { store.apply(event) }
        if update.active {
            wasActive = true
            return true
        }
        guard wasActive else { return true }
        ended = update.reason ?? .ended
        return false
    }
}
