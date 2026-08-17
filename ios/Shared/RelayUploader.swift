import Foundation
import CaptionRelay

/// Posts captured audio to the relay, roughly once a second.
///
/// The write half of the Watch's `HTTPRelayClient`, and nothing more: this side
/// never reads captions back, so there is no cursor, no event decoding and no
/// `ready` handshake. It posts into `PhoneAudio.sessionID`, which the Watch
/// polls separately.
///
/// `ephemeral=1` on every request, not just the first: the relay reaps idle
/// sessions, and a session it recreated from a later post must come back live
/// rather than quietly starting to save. A podcast does not belong in the
/// transcript list.
final class RelayUploader: @unchecked Sendable {
    private let base: URL
    /// Resolves this device's bearer token from `DeviceIdentity`. A provider
    /// rather than a stored `String`, so construction stays synchronous and
    /// the token — which may need a first-launch registration round trip —
    /// resolves lazily on first use instead. See `HTTPRelayClient` (the
    /// Watch's equivalent) for the fuller rationale.
    private let token: @Sendable () async throws -> String
    private let session: URLSession
    private let queue = DispatchQueue(label: "relay.upload")

    private var pending = Data()
    private var inFlight = false
    private var stopped = false
    private var timer: DispatchSourceTimer?
    /// The token, once resolved. `start()` kicks off resolution immediately
    /// rather than waiting for the first `flush()`, so this is very likely
    /// already set by the time `stop()` needs it — `stop()` runs from
    /// `broadcastFinished()`, after which the OS can kill this process at
    /// any moment, and every extra `await` on the way out is a chance the
    /// "tell the relay to release the session" POST never goes out at all.
    private var resolvedToken: String?

    private let flushInterval = 1.0

    /// The cap on audio waiting to be posted. This runs inside a broadcast
    /// extension held to 50 MB, and a backlog is worthless anyway: captions
    /// arriving a minute late are worse than a gap, because the reader is
    /// trying to follow something they are hearing now. Two seconds of 16 kHz
    /// mono Int16 is 64 KB.
    private let maxPending = 64_000

    init(base: URL, token: @escaping @Sendable () async throws -> String) {
        self.base = base
        self.token = token
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 15
        session = URLSession(configuration: config)
    }

    func start() {
        queue.async { [weak self] in
            guard let self else { return }
            self.stopped = false
            self.pending = Data()
            self.inFlight = false
            let timer = DispatchSource.makeTimerSource(queue: self.queue)
            timer.schedule(deadline: .now() + self.flushInterval, repeating: self.flushInterval)
            timer.setEventHandler { [weak self] in self?.flush() }
            timer.resume()
            self.timer = timer

            // Resolve the token now rather than on the first flush a second
            // from now, so `stop()` has the best chance of finding it
            // already in hand — see `resolvedToken`.
            guard self.resolvedToken == nil else { return }
            let token = self.token
            Task { [weak self] in
                guard let self, let bearer = try? await token() else { return }
                self.queue.async { self.resolvedToken = bearer }
            }
        }
    }

    /// Queue wire-format audio. Safe to call from the audio thread.
    func send(_ audio: Data) {
        queue.async { [weak self] in
            guard let self, !self.stopped else { return }
            self.pending.append(audio)
            if self.pending.count > self.maxPending {
                self.pending.removeFirst(self.pending.count - self.maxPending)
            }
        }
    }

    /// Stop posting and release the session, so the relay closes its upstream
    /// connection rather than holding it open until the idle reaper runs.
    func stop() {
        queue.async { [weak self] in
            guard let self, !self.stopped else { return }
            self.stopped = true
            self.timer?.cancel()
            self.timer = nil
            let url = self.url(path: "v1/stop")
            let session = self.session

            // The common case: `start()` already resolved this, so the
            // request goes out with no further `await` between here and the
            // process's teardown.
            if let bearer = self.resolvedToken {
                var request = URLRequest(url: url)
                request.httpMethod = "POST"
                request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
                session.dataTask(with: request).resume()
                return
            }

            // Not resolved yet — the broadcast stopped almost immediately
            // after starting. Best-effort fallback: still try, but there is
            // now one more `await` between here and a process the OS may
            // already be tearing down.
            let token = self.token
            Task {
                guard let bearer = try? await token() else { return }
                var request = URLRequest(url: url)
                request.httpMethod = "POST"
                request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
                session.dataTask(with: request).resume()
            }
        }
    }

    /// Counts flushes so the log can say what is happening without a line a
    /// second: the first few posts, then one every ten.
    private var flushes = 0

    private func flush() {
        guard !stopped, !inFlight else { return }
        guard !pending.isEmpty else {
            // Silence here is the failure that looks like success: the app
            // reports it is streaming while the capture produces nothing.
            flushes += 1
            if flushes <= 3 || flushes % 10 == 0 {
                UploadLog.append("nothing to post — capture produced no audio")
            }
            return
        }
        flushes += 1
        if flushes <= 3 || flushes % 10 == 0 {
            UploadLog.append("posting \(pending.count) bytes")
        }
        inFlight = true
        let body = pending
        pending = Data()
        let requestURL = url(path: "v1/audio")

        // The common case: `start()` already resolved the token, so this
        // goes straight out with no `await` (and so no window for `stopped`
        // to change underneath it — see the fallback below, which re-checks
        // it for exactly that reason).
        if let bearer = resolvedToken {
            post(requestURL, body: body, bearer: bearer)
            return
        }

        let token = self.token
        Task { [weak self] in
            guard let self else { return }
            guard let bearer = try? await token() else {
                self.queue.async {
                    self.inFlight = false
                    UploadLog.append("post failed: could not resolve device token")
                }
                return
            }

            // Re-enter `queue` and re-check `stopped`: `await token()` just
            // suspended, and `stop()` — which also runs on `queue` — could
            // have posted `v1/stop` while it did. Sending this POST after
            // that would recreate the session the relay was just told to
            // release.
            self.queue.async {
                guard !self.stopped else {
                    self.inFlight = false
                    return
                }
                self.resolvedToken = bearer
                self.post(requestURL, body: body, bearer: bearer)
            }
        }
    }

    /// Issues the `v1/audio` POST. Always called already on `queue`.
    private func post(_ url: URL, body: Data, bearer: String) {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        request.httpBody = body

        session.dataTask(with: request) { [weak self] _, response, error in
            self?.queue.async {
                guard let self else { return }
                self.inFlight = false
                // Nothing to retry into: the audio is already gone, and holding
                // it would only push captions further behind. Log and continue,
                // so a blip costs a second rather than the session.
                if let error {
                    UploadLog.append("post failed: \(error.localizedDescription)")
                } else if let http = response as? HTTPURLResponse, http.statusCode != 200 {
                    UploadLog.append("post failed: HTTP \(http.statusCode)")
                }
            }
        }.resume()
    }

    private func url(path: String) -> URL {
        var components = URLComponents(
            url: base.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "session", value: PhoneAudio.sessionID),
            URLQueryItem(name: "ephemeral", value: "1"),
        ]
        return components.url!
    }
}
