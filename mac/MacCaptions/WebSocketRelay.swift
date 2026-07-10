import Foundation
import CaptionCore

/// Reconnect schedule: 0.5s → 8s capped, giving up after ~30s of consecutive failure.
struct ReconnectPolicy {
    private var attempt = 0
    private var elapsed: TimeInterval = 0
    private let maxElapsed: TimeInterval = 30

    mutating func nextDelay() -> TimeInterval? {
        guard elapsed < maxElapsed else { return nil }
        let delay = min(0.5 * pow(2, Double(attempt)), 8)
        attempt += 1
        elapsed += delay
        return delay
    }

    mutating func reset() {
        attempt = 0
        elapsed = 0
    }
}

/// `Relay` over the backend's WebSocket endpoint. Reconnects transparently on
/// drops; calls `onClose` only when the reconnect budget is exhausted.
final class WebSocketRelay: NSObject, Relay {
    var onMessage: (@MainActor (ServerMessage) -> Void)?
    var onClose: (@MainActor () -> Void)?

    private let url: URL
    private var task: URLSessionWebSocketTask?
    private var session: URLSession!
    private var policy = ReconnectPolicy()
    private var stopped = true
    private let queue = DispatchQueue(label: "relay.ws")

    init(base: URL, token: String, channels: Int, provider: CaptionProvider = .deepgram) {
        var c = URLComponents(url: base.appendingPathComponent("stream"), resolvingAgainstBaseURL: false)!
        c.scheme = base.scheme == "http" ? "ws" : "wss"
        c.queryItems = [
            URLQueryItem(name: "token", value: token),
            URLQueryItem(name: "channels", value: String(channels)),
            URLQueryItem(name: "provider", value: provider.rawValue),
        ]
        url = c.url!
        super.init()
        session = URLSession(configuration: .default, delegate: nil, delegateQueue: nil)
    }

    func connect() {
        queue.async { [weak self] in
            guard let self else { return }
            // Cancel any existing task so repeated connect() calls (e.g. from the
            // app returning to the foreground) don't leak the old socket.
            self.task?.cancel(with: .normalClosure, reason: nil)
            self.task = nil
            self.stopped = false
            self.policy.reset()
            self.open()
        }
    }

    func send(_ audio: Data) {
        queue.async { [weak self] in
            self?.task?.send(.data(audio)) { _ in }  // drop errors; reconnect path handles the failure
        }
    }

    func close() {
        queue.async { [weak self] in
            guard let self else { return }
            self.stopped = true
            self.task?.cancel(with: .normalClosure, reason: nil)
            self.task = nil
        }
    }

    // MARK: - Internals (all run on `queue`)

    private func open() {
        let t = session.webSocketTask(with: url)
        task = t
        t.resume()
        receiveLoop(on: t)
    }

    private func receiveLoop(on t: URLSessionWebSocketTask) {
        t.receive { [weak self] result in
            guard let self else { return }
            self.queue.async {
                guard self.task === t else { return }
                switch result {
                case .success(let message):
                    self.policy.reset()
                    if let serverMessage = self.decode(message), let onMessage = self.onMessage {
                        Task { @MainActor in onMessage(serverMessage) }
                    }
                    self.receiveLoop(on: t)
                case .failure:
                    self.handleDrop()
                }
            }
        }
    }

    private func decode(_ message: URLSessionWebSocketTask.Message) -> ServerMessage? {
        switch message {
        case .string(let s): return try? ServerMessage.decode(Data(s.utf8))
        case .data(let d): return try? ServerMessage.decode(d)
        @unknown default: return nil
        }
    }

    private func handleDrop() {
        guard !stopped else { return }
        guard let delay = policy.nextDelay() else {
            stopped = true
            if let onClose { Task { @MainActor in onClose() } }
            return
        }
        queue.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, !self.stopped else { return }
            self.open()
        }
    }
}
