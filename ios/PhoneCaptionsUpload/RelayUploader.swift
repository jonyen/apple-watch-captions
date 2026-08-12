import Foundation
import CaptionCore

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
final class RelayUploader {
    private let base: URL
    private let token: String
    private let session: URLSession
    private let queue = DispatchQueue(label: "relay.upload")

    private var pending = Data()
    private var inFlight = false
    private var stopped = false
    private var timer: DispatchSourceTimer?

    private let flushInterval = 1.0

    /// The cap on audio waiting to be posted. This runs inside a broadcast
    /// extension held to 50 MB, and a backlog is worthless anyway: captions
    /// arriving a minute late are worse than a gap, because the reader is
    /// trying to follow something they are hearing now. Two seconds of 16 kHz
    /// mono Int16 is 64 KB.
    private let maxPending = 64_000

    init(base: URL, token: String) {
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
            var request = URLRequest(url: self.url(path: "v1/stop"))
            request.httpMethod = "POST"
            self.session.dataTask(with: request).resume()   // best-effort
        }
    }

    private func flush() {
        guard !stopped, !inFlight, !pending.isEmpty else { return }
        inFlight = true
        let body = pending
        pending = Data()

        var request = URLRequest(url: url(path: "v1/audio"))
        request.httpMethod = "POST"
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
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
            URLQueryItem(name: "token", value: token),
            URLQueryItem(name: "ephemeral", value: "1"),
        ]
        return components.url!
    }
}
