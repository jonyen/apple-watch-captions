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
    /// Sessions whose lines are fully delivered and finished, but whose
    /// `/v1/stop` hasn't been confirmed yet. Deliberately not part of
    /// `ForwardQueue`: `delivered(...)` drops a finished+empty entry the
    /// moment it becomes empty (that is its documented contract, and
    /// changing it would break the token-hygiene guarantee it exists for),
    /// so once an entry is delivered there is nothing left in the queue to
    /// retry a stop against — this in-memory, session-scoped dictionary is
    /// where that retry state lives instead. Not persisted: like every other
    /// client's `/v1/stop` in this codebase, it's best-effort — the relay's
    /// idle timeout finalizes the session anyway if the app is killed before
    /// this ever lands.
    private var pendingStops: [String: String] = [:]  // sessionId -> token
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
    /// poll timer, backoff timer) funnels through. Runs on `queue`. A pending
    /// stop always takes priority over a fresh caption POST — it represents
    /// a session that is otherwise fully delivered, so there is nothing else
    /// useful to do for it besides retiring the stop.
    private func scheduleDelivery() {
        guard !backingOff else { return }
        guard !inFlight else {
            replayPending = true
            return
        }
        if let (sessionId, token) = pendingStops.first {
            inFlight = true
            retryStop(sessionId: sessionId, token: token)
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

    /// Runs on `queue`, after a successful `/v1/captions` POST for `entry`
    /// (a pre-POST snapshot — never trusted for the finished decision below,
    /// since `markFinished` may have landed on the live queue while the POST
    /// was in flight).
    private func captionsDelivered(_ entry: ForwardQueue.Entry) {
        let deliveredCount = entry.lines.count

        // The live finished flag, read *before* `delivered(...)` — which may
        // drop the entry outright once it is both finished and empty — is
        // the only way to still know a stop is owed once that happens.
        let liveFinished = forwardQueue.entries.first(where: { $0.sessionId == entry.sessionId })?.finished ?? false

        // Commit exactly the lines this POST actually sent, unconditionally
        // and before anything else: a `/v1/stop` failure below must never
        // cause these already-accepted lines to be replayed and duplicated
        // on the relay. `finished: false` only reports what this stale
        // snapshot believed; `ForwardQueue.delivered` merges it sticky, so
        // `liveFinished`, computed above, survives regardless.
        forwardQueue.delivered(sessionId: entry.sessionId, lineCount: deliveredCount, finished: false)
        persist()

        guard liveFinished else {
            deliverySucceeded()
            return
        }

        // Fully delivered and finished: the only thing left is the stop.
        // `forwardQueue` may already have dropped this entry above (if it
        // was also empty) — `pendingStops` is what keeps the stop retryable
        // regardless.
        pendingStops[entry.sessionId] = entry.token
        retryStop(sessionId: entry.sessionId, token: entry.token)
    }

    /// Runs on `queue`. Posts `/v1/stop` for a session already recorded in
    /// `pendingStops`; on success, retires it there (the only place it was
    /// ever tracked) and resumes normal delivery, on failure leaves it for
    /// the next pass.
    private func retryStop(sessionId: String, token: String) {
        var req = URLRequest(url: stopURL(sessionId: sessionId))
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        session.dataTask(with: req) { [weak self] _, response, error in
            guard let self else { return }
            self.queue.async {
                guard error == nil, let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                    self.deliveryFailed()
                    return
                }
                self.pendingStops.removeValue(forKey: sessionId)
                self.deliverySucceeded()
            }
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
