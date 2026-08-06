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
    /// The loop a later `start()`/`stop()` superseded. Retained only so tests
    /// can await it; production never waits on either slot.
    private var supersededTask: Task<Void, Never>?
    /// Identifies the current loop, mirroring `SessionController.generation`.
    /// `client.poll` has no cancellation hook, so a poll already in flight when
    /// `start()`/`stop()` runs can still resume afterward and try to write into
    /// the fields that reset just cleared — `task?.cancel()` alone is only a
    /// request, not a guarantee. Comparing generation after every await is what
    /// keeps that stale answer from landing in a session it does not belong to.
    private var generation = 0

    public init(client: CallClient, store: CaptionStore) {
        self.client = client
        self.store = store
    }

    /// Begin reading. Safe to call again; the previous loop is replaced.
    public func start() {
        generation += 1
        store.reset()
        seq = 0
        wasActive = false
        ended = nil
        task?.cancel()
        supersededTask = task
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
        generation += 1
        task?.cancel()
        supersededTask = task
        task = nil
    }

    /// One poll. False when the call is over and polling should stop. A failed
    /// request keeps the loop alive — a watch out of range is not an answer.
    /// An answer that comes back after a later `start()`/`stop()` has moved the
    /// loop to a new generation is handled the same way — keep going — but its
    /// data is dropped rather than written into a session it is not part of.
    @discardableResult
    public func poll() async -> Bool {
        let generation = self.generation
        let update = try? await client.poll(since: seq)
        guard self.generation == generation else { return true }
        guard let update else { return true }
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

    /// Awaits the loop a `start()`/`stop()` superseded. Tests only —
    /// production never waits on it.
    func waitForSupersededLoop() async {
        await supersededTask?.value
    }
}
