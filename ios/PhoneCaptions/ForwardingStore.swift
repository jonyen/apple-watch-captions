import Foundation
import CaptionRelay

/// Owns the on-disk `ForwardQueue` for kept phone-transcribed sessions and
/// replays it against the relay so a session survives even when the phone
/// only reconnects to the network minutes (or longer) after the watch
/// finished talking to it.
///
/// Every kept final line and every `finished` event from
/// `WCTranscriberService.onKeptSessionEvent` lands here first — the queue is
/// the durable record; the relay POSTs are just best-effort replay of it.
/// `WCTranscriberService` fires that callback on its own serial queue, so
/// every entry point here hops onto this type's own serial `queue` before
/// touching `ForwardQueue` — no state is ever shared unsynchronized across
/// the two.
///
/// Delivery is single-flight: only one replay runs at a time, and a
/// retrigger that arrives while one is in flight coalesces into a single
/// follow-up pass rather than piling up.
final class ForwardingStore: @unchecked Sendable {
    private let queue = DispatchQueue(label: "forwarding.store")
    private let session: URLSession
    private let base: URL
    private let fileURL: URL

    private var forwardQueue = ForwardQueue()
    private let batchThreshold = 10
    private let backoffInterval: TimeInterval = 60

    private var inFlight = false
    /// Set when a retrigger arrives while a replay is already in flight, so
    /// the in-flight replay's completion kicks off exactly one more pass
    /// rather than the caller starting a second concurrent one.
    private var replayPending = false
    /// Set after a failed delivery; cleared once the backoff timer fires.
    /// While set, `scheduleDelivery` does nothing — the timer itself is what
    /// re-attempts.
    private var backingOff = false
    private var backoffTimer: DispatchSourceTimer?
    private var pollTimer: DispatchSourceTimer?

    /// `base` is the relay's HTTP(S) origin; `fileURL` is where the queue is
    /// persisted (default: `Application Support/forward-queue.json` in the
    /// app container, created if missing).
    init(base: URL = Secrets.relayURL, fileURL: URL = ForwardingStore.defaultFileURL()) {
        self.base = base
        self.fileURL = fileURL
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 15
        session = URLSession(configuration: config)
        queue.async { [weak self] in
            self?.load()
        }
    }

    static func defaultFileURL() -> URL {
        let fm = FileManager.default
        let dir = (try? fm.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                appropriateFor: nil, create: true))
            ?? fm.temporaryDirectory
        return dir.appendingPathComponent("forward-queue.json")
    }

    /// Subscribes to `WCTranscriberService.onKeptSessionEvent` and starts the
    /// 60 s poll timer. Call once, at app launch.
    func start(service: WCTranscriberService) {
        service.onKeptSessionEvent = { [weak self] event in
            self?.handle(event)
        }
        queue.async { [weak self] in
            self?.startPollTimer()
        }
    }

    /// Call when the app returns to the foreground, to retrigger delivery
    /// without waiting for the next poll tick.
    func foregrounded() {
        queue.async { [weak self] in
            self?.scheduleDelivery()
        }
    }

    // MARK: - WCTranscriberService.KeptEvent (arrives on its own queue)

    private func handle(_ event: WCTranscriberService.KeptEvent) {
        queue.async { [weak self] in
            guard let self else { return }
            switch event {
            case .line(let sessionId, let token, let caption):
                self.forwardQueue.append(sessionId: sessionId, token: token, caption: caption)
            case .finished(let sessionId, let token):
                self.forwardQueue.markFinished(sessionId: sessionId, token: token)
            }
            self.persist()
            self.scheduleDelivery()
        }
    }

    // MARK: - Persistence (runs on `queue`)

    private func load() {
        guard let data = try? Data(contentsOf: fileURL),
              let loaded = try? JSONDecoder().decode(ForwardQueue.self, from: data)
        else { return }
        forwardQueue = loaded
    }

    private func persist() {
        guard let data = try? JSONEncoder().encode(forwardQueue) else { return }
        let dir = fileURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? data.write(to: fileURL, options: .atomic)
    }

    // MARK: - Delivery (runs on `queue`)

    private func startPollTimer() {
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + backoffInterval, repeating: backoffInterval)
        t.setEventHandler { [weak self] in self?.scheduleDelivery() }
        t.resume()
        pollTimer = t
    }

    /// The single entry point every retrigger (append, finished, foreground,
    /// poll timer, backoff timer) funnels through. Runs on `queue`.
    private func scheduleDelivery() {
        guard !backingOff else { return }
        guard !inFlight else {
            replayPending = true
            return
        }
        guard let entry = forwardQueue.nextDeliverable(batchThreshold: batchThreshold) else { return }
        inFlight = true
        deliver(entry)
    }

    private func deliver(_ entry: ForwardQueue.Entry) {
        let url = capturesURL(sessionId: entry.sessionId)
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(entry.token)", forHTTPHeaderField: "Authorization")
        req.httpBody = Self.body(for: entry.lines)

        session.dataTask(with: req) { [weak self] data, response, error in
            guard let self else { return }
            self.queue.async {
                guard error == nil, let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                    self.deliveryFailed()
                    return
                }
                self.captionsDelivered(entry)
            }
        }.resume()
    }

    /// Runs on `queue`, after a successful `/v1/captions` POST.
    private func captionsDelivered(_ entry: ForwardQueue.Entry) {
        let deliveredCount = entry.lines.count
        if entry.finished {
            postStop(entry) { [weak self] stopSucceeded in
                self?.queue.async {
                    guard let self else { return }
                    guard stopSucceeded else {
                        self.deliveryFailed()
                        return
                    }
                    self.forwardQueue.delivered(sessionId: entry.sessionId, lineCount: deliveredCount, finished: true)
                    self.persist()
                    self.deliverySucceeded()
                }
            }
        } else {
            forwardQueue.delivered(sessionId: entry.sessionId, lineCount: deliveredCount, finished: false)
            persist()
            deliverySucceeded()
        }
    }

    private func postStop(_ entry: ForwardQueue.Entry, completion: @escaping (Bool) -> Void) {
        var req = URLRequest(url: stopURL(sessionId: entry.sessionId))
        req.httpMethod = "POST"
        req.setValue("Bearer \(entry.token)", forHTTPHeaderField: "Authorization")
        session.dataTask(with: req) { _, response, error in
            let ok = error == nil && (response as? HTTPURLResponse)?.statusCode == 200
            completion(ok)
        }.resume()
    }

    private func deliverySucceeded() {
        replayPending = false
        inFlight = false
        // More may already qualify (another entry, or this one again if it
        // still holds lines) — keep draining until nothing does.
        scheduleDelivery()
    }

    private func deliveryFailed() {
        inFlight = false
        replayPending = false
        backingOff = true
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + backoffInterval)
        t.setEventHandler { [weak self] in
            guard let self else { return }
            self.backingOff = false
            self.backoffTimer = nil
            self.scheduleDelivery()
        }
        t.resume()
        backoffTimer = t
    }

    // MARK: - Requests

    private func capturesURL(sessionId: String) -> URL {
        var c = URLComponents(url: base.appendingPathComponent("v1/captions"), resolvingAgainstBaseURL: false)!
        c.queryItems = [URLQueryItem(name: "session", value: sessionId)]
        return c.url!
    }

    private func stopURL(sessionId: String) -> URL {
        var c = URLComponents(url: base.appendingPathComponent("v1/stop"), resolvingAgainstBaseURL: false)!
        c.queryItems = [URLQueryItem(name: "session", value: sessionId)]
        return c.url!
    }

    /// `{"lines":[{"text":"…","isFinal":true}, …]}` — matches the relay's
    /// existing `/v1/captions` batch shape (see `CaptionUploader`).
    private static func body(for lines: [PhoneWire.Caption]) -> Data {
        let encoded = lines.map { ["text": $0.text, "isFinal": $0.isFinal] as [String: Any] }
        return (try? JSONSerialization.data(withJSONObject: ["lines": encoded]))
            ?? Data(#"{"lines":[]}"#.utf8)
    }
}
