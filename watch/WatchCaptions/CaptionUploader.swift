import Foundation
import os

/// Sends caption lines to the relay's `/stream` WebSocket, so a session whose
/// captions are computed on the watch still leaves a transcript on the relay.
///
/// The write half only: no audio ever goes up this socket, and whatever the
/// relay sends back is read and discarded — the local engine is the source of
/// truth for the screen. Each final line goes up as a text frame,
/// `{"caption":{"text":"…","isFinal":true}}`, which the relay stores exactly
/// like a line it transcribed itself; a caption-only session sends no audio,
/// and the relay finalizes the transcript when the socket closes, so
/// `close()` is the whole "done" gesture.
///
/// Failure here is lost persistence, never a session error: captions keep
/// coming from the local engine either way. A connect or send failure only
/// logs and reports through `onKept`, so the captions screen can fall back to
/// its not-saved indicator. There is no reconnect: a session that loses the
/// relay midway finishes as a partial transcript rather than juggling gaps.
///
/// The handshake mirrors what the other relay clients derive from
/// `Secrets.relayURL`: that wss URL is used as-is — it already names
/// `/stream` — with this device's bearer token appended as `?token=`, which
/// is where the relay's upgrade handler looks (WebSocket upgrades carry the
/// token in the query, unlike the HTTP endpoints' `Authorization` header —
/// sent here too, for symmetry with those clients).
///
/// `@unchecked Sendable`: all mutable state is confined to `queue`, the same
/// discipline as `HTTPRelayClient`.
final class CaptionUploader: @unchecked Sendable {
    /// Reports whether lines are reaching the relay: true after the first
    /// send the socket acknowledges, false again if the socket fails later.
    /// Never fires for a clean `close()`.
    var onKept: (@MainActor (Bool) -> Void)?

    private let url: URL
    /// Resolves this device's bearer token — the same provider every relay
    /// client holds, resolved when the connection is actually made.
    private let token: @Sendable () async throws -> String
    private let session: URLSession
    private let queue = DispatchQueue(label: "caption.uploader")

    private var task: URLSessionWebSocketTask?
    /// Frames queued while the token resolves; the socket task itself queues
    /// anything sent before its handshake finishes.
    private var pending: [String] = []
    private var closed = false
    private var failed = false
    private var kept = false
    private let log = Logger(subsystem: "com.jonyen.watchcaptions", category: "CaptionUploader")

    /// `url` is the relay's `/stream` WebSocket URL (`Secrets.relayURL`);
    /// `token` authorizes the upgrade.
    init(url: URL = Secrets.relayURL, token: @escaping @Sendable () async throws -> String) {
        self.url = url
        self.token = token
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 15   // fail the handshake rather than hang
        session = URLSession(configuration: config)
    }

    /// Open the socket. Lines sent before it is up are queued, so the first
    /// sentence of the session is kept, not raced against the handshake.
    func connect() {
        let token = self.token
        Task { [weak self] in
            let bearer: String
            do {
                bearer = try await token()
            } catch {
                self?.queue.async { self?.fail("could not resolve device token: \(error)") }
                return
            }
            guard let self else { return }
            self.queue.async {
                guard !self.closed, !self.failed, self.task == nil else { return }
                var request = URLRequest(url: self.streamURL(bearer: bearer))
                request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
                let task = self.session.webSocketTask(with: request)
                self.task = task
                task.resume()
                self.receiveLoop(task)
                let queued = self.pending
                self.pending.removeAll()
                for frame in queued { self.transmit(frame, over: task) }
            }
        }
    }

    /// Queue one caption line. Safe to call from any thread; drops silently
    /// once the socket has failed — the loss is already reported via `onKept`.
    func send(text: String, isFinal: Bool) {
        guard let frame = Self.frame(text: text, isFinal: isFinal) else { return }
        queue.async { [weak self] in
            guard let self, !self.closed, !self.failed else { return }
            if let task = self.task {
                self.transmit(frame, over: task)
            } else {
                self.pending.append(frame)
            }
        }
    }

    /// Close the socket normally. This is what tells the relay the session is
    /// over: it finalizes the transcript on close.
    func close() {
        queue.async { [weak self] in
            guard let self, !self.closed else { return }
            self.closed = true
            self.pending.removeAll()
            self.task?.cancel(with: .normalClosure, reason: nil)
            self.task = nil
        }
    }

    // MARK: - Internals (all run on `queue`)

    /// `Secrets.relayURL` with the bearer token in the query, where the
    /// relay's upgrade handler reads it.
    private func streamURL(bearer: String) -> URL {
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        var items = components.queryItems ?? []
        items.append(URLQueryItem(name: "token", value: bearer))
        components.queryItems = items
        return components.url!
    }

    private static func frame(text: String, isFinal: Bool) -> String? {
        let object: [String: Any] = ["caption": ["text": text, "isFinal": isFinal]]
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func transmit(_ frame: String, over task: URLSessionWebSocketTask) {
        task.send(.string(frame)) { [weak self] error in
            guard let self else { return }
            self.queue.async {
                guard !self.closed else { return }
                if let error {
                    self.fail("send failed: \(error.localizedDescription)")
                } else if !self.kept {
                    // First acknowledged line: the transcript exists on the
                    // relay now, so the screen may say so.
                    self.kept = true
                    self.deliverKept(true)
                }
            }
        }
    }

    /// Read and discard whatever the relay sends. The loop exists to notice
    /// the socket dying — a server-side close or transport failure surfaces
    /// here — not for the content.
    private func receiveLoop(_ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self else { return }
            self.queue.async {
                guard !self.closed, !self.failed else { return }
                switch result {
                case .success:
                    self.receiveLoop(task)
                case .failure(let error):
                    self.fail("socket failed: \(error.localizedDescription)")
                }
            }
        }
    }

    /// Give up on persistence, quietly: log, drop the socket and anything
    /// queued, and let `onKept` downgrade the indicator. The session itself
    /// is never touched.
    private func fail(_ reason: String) {
        guard !closed, !failed else { return }
        failed = true
        log.error("captions not kept — \(reason, privacy: .public)")
        pending.removeAll()
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        if kept {
            kept = false
            deliverKept(false)
        }
    }

    private func deliverKept(_ kept: Bool) {
        if let onKept { Task { @MainActor in onKept(kept) } }
    }
}
