import Foundation
import CaptionCore

/// `Relay` over plain HTTP. watchOS blocks WebSockets for normal apps (TN3135),
/// but high-level `URLSession` requests are always allowed. Audio is batched and
/// POSTed roughly once per second; new caption events come back in each response.
final class HTTPRelayClient: Relay {
    var onMessage: (@MainActor (ServerMessage) -> Void)?
    var onClose: (@MainActor () -> Void)?
    /// Fires once with the transcript this session is writing to, so the app
    /// can offer to resume it later. The relay assigns the name — and sends
    /// none for a live session, so this never fires for one.
    var onTranscript: (@MainActor (String) -> Void)?

    private let base: URL
    private let token: String
    private let session: URLSession
    private let queue = DispatchQueue(label: "relay.http")

    private var sessionID = UUID().uuidString
    private var resumeName: String?
    /// Live-only session: ask the relay to keep nothing. Set per connect, and
    /// sent on every request so a session the relay reaped and recreated comes
    /// back live rather than silently starting to save.
    private var ephemeral = false
    private var transcriptDelivered = false
    private var pending = Data()        // accumulated PCM awaiting the next flush
    private var lastSeq = 0
    private var inFlight = false
    private var readyDelivered = false
    private var stopped = false
    private var timer: DispatchSourceTimer?

    private let flushInterval = 1.0

    /// `base` is the relay origin (e.g. https://host); `token` authorizes requests.
    init(base: URL, token: String) {
        self.base = base
        self.token = token
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 15   // surface "Connection lost" rather than hang
        session = URLSession(configuration: config)
    }

    func connect(mode: SessionMode) {
        queue.async { [weak self] in
            guard let self else { return }
            // Start a fresh session each connect so reconnects (Try Again, returning
            // to the foreground, a network change) don't reuse stale state. When
            // resuming, the relay binds that new session to an existing transcript.
            self.timer?.cancel()
            self.sessionID = UUID().uuidString
            switch mode {
            case .saved(let name):
                self.resumeName = name
                self.ephemeral = false
            case .live:
                self.resumeName = nil
                self.ephemeral = true
            }
            self.transcriptDelivered = false
            self.pending = Data()
            self.lastSeq = 0
            self.readyDelivered = false
            self.inFlight = false
            self.stopped = false
            self.startTimer()
            self.flush()   // immediate first POST establishes the session
        }
    }

    func send(_ audio: Data) {
        queue.async { [weak self] in self?.pending.append(audio) }
    }

    func close() {
        queue.async { [weak self] in
            guard let self else { return }
            self.stopped = true
            self.timer?.cancel()
            self.timer = nil
            var req = URLRequest(url: self.url(path: "v1/stop"))
            req.httpMethod = "POST"
            self.session.dataTask(with: req).resume()   // best-effort release
        }
    }

    // MARK: - Internals (all run on `queue`)

    private func startTimer() {
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + flushInterval, repeating: flushInterval)
        t.setEventHandler { [weak self] in self?.flush() }
        t.resume()
        timer = t
    }

    private func flush() {
        guard !stopped, !inFlight else { return }
        inFlight = true
        let body = pending
        pending = Data()

        var req = URLRequest(url: url(path: "v1/audio", since: lastSeq))
        req.httpMethod = "POST"
        req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        req.httpBody = body

        session.dataTask(with: req) { [weak self] data, response, error in
            guard let self else { return }
            self.queue.async {
                self.inFlight = false
                guard !self.stopped else { return }
                guard error == nil, let data,
                      let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                    self.fail()
                    return
                }
                self.deliverReadyIfNeeded()
                self.handle(data)
            }
        }.resume()
    }

    /// Build a request URL for the current session, optionally with a `since` cursor.
    private func url(path: String, since: Int? = nil) -> URL {
        var c = URLComponents(
            url: base.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        var items = [
            URLQueryItem(name: "session", value: sessionID),
            URLQueryItem(name: "token", value: token),
        ]
        if let since { items.append(URLQueryItem(name: "since", value: String(since))) }
        if let resumeName { items.append(URLQueryItem(name: "resume", value: resumeName)) }
        if ephemeral { items.append(URLQueryItem(name: "ephemeral", value: "1")) }
        c.queryItems = items
        return c.url!
    }

    private func deliverReadyIfNeeded() {
        guard !readyDelivered else { return }
        readyDelivered = true
        emit(.ready)   // the client owns the single .ready that starts audio capture
    }

    private func handle(_ data: Data) {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return }
        if let seq = obj["seq"] as? Int { lastSeq = max(lastSeq, seq) }
        if let name = obj["transcript"] as? String {
            if ephemeral {
                // A relay without ephemeral support treats `ephemeral=1` as an
                // unrecognized query parameter: it saves the session, summarizes
                // it, and exports it to Notion — exactly what live caption
                // promises never to do — and still hands back a `transcript`
                // name, same as a saved session's response. Latching onto it
                // here would leave the app showing the hollow "Live only, not
                // saved" indicator while the relay quietly keeps everything, so
                // fail loudly instead, the same as a transport failure, rather
                // than let the user discover a saved transcript afterwards.
                failEphemeralMismatch()
                return
            }
            // Bind to this transcript from now on, so a session the relay has
            // since reaped resumes into it rather than opening a new one.
            resumeName = name
            if !transcriptDelivered {
                transcriptDelivered = true
                if let onTranscript { Task { @MainActor in onTranscript(name) } }
            }
        }
        guard let events = obj["events"] as? [[String: Any]] else { return }
        for event in events {
            switch event["type"] as? String {
            case "ready":
                continue   // suppress server ready; we already synthesized one
            case "caption":
                let text = event["text"] as? String ?? ""
                let isFinal = event["isFinal"] as? Bool ?? false
                emit(.caption(text: text, isFinal: isFinal, channel: event["channel"] as? Int))
            case "error":
                emit(.error(message: event["message"] as? String ?? "error"))
            default:
                continue
            }
        }
    }

    private func fail() {
        guard !stopped else { return }
        stopped = true
        timer?.cancel()
        timer = nil
        if let onClose { Task { @MainActor in onClose() } }
    }

    /// Torn down the same way `fail()` handles a transport failure, but via
    /// `onMessage(.error)` rather than `onClose` so the app can show a message
    /// specific to this cause instead of the generic "Connection lost".
    private func failEphemeralMismatch() {
        guard !stopped else { return }
        stopped = true
        timer?.cancel()
        timer = nil
        emit(.error(message: "This relay can't do live captions"))
    }

    private func emit(_ message: ServerMessage) {
        if let onMessage { Task { @MainActor in onMessage(message) } }
    }
}
