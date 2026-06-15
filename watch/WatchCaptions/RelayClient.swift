import Foundation
import CaptionCore

/// `Relay` over URLSessionWebSocketTask. Callbacks hop to the main actor.
final class RelayClient: Relay {
    var onMessage: (@MainActor (ServerMessage) -> Void)?
    var onClose: (@MainActor () -> Void)?

    private let url: URL
    private let session = URLSession(configuration: .default)
    private var task: URLSessionWebSocketTask?

    /// `url` must already include `?token=…`.
    init(url: URL) { self.url = url }

    func connect() {
        let task = session.webSocketTask(with: url)
        self.task = task
        task.resume()
        receive()
    }

    func send(_ audio: Data) {
        task?.send(.data(audio)) { _ in }
    }

    func close() {
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
    }

    private func receive() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure:
                Task { @MainActor in self.onClose?() }
            case .success(let message):
                if let data = Self.payload(of: message),
                   let parsed = try? ServerMessage.decode(data) {
                    Task { @MainActor in self.onMessage?(parsed) }
                }
                self.receive()   // keep listening
            }
        }
    }

    private static func payload(of message: URLSessionWebSocketTask.Message) -> Data? {
        switch message {
        case .string(let s): return Data(s.utf8)
        case .data(let d): return d
        @unknown default: return nil
        }
    }
}
