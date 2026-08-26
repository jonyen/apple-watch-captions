import Foundation
import os

/// Streams a kept-on-device session's raw PCM to the relay's
/// `POST /v1/audio-archive?session=<id>` endpoint, batched the same way
/// `CaptionUploader` batches caption lines — same session id (passed in at
/// init, minted once by the sibling `CaptionUploader` for this session),
/// same in-flight/queue discipline, same retry-once-then-drop degrade on
/// failure.
///
/// Archiving is purely additive: it exists so the relay can build a
/// self-labeled fine-tuning dataset from the same audio Moonshine is
/// already captioning on-device. A failure here must never interrupt
/// captioning (the caption path never even learns this type exists) and
/// must never move the kept/not-kept indicator, which reflects caption
/// persistence only — this type has no `onKept` at all, unlike
/// `CaptionUploader`.
///
/// No `close()`-time stop of its own: the sibling `CaptionUploader` for the
/// same session id posts `/v1/stop`, which finalizes both the transcript
/// and the archive on the relay (`SessionStore.finalizeSession` calls
/// `TrainingCapture.archiveFinalize` unconditionally, alongside — not
/// instead of — the live-transcript finalize). Posting a second, redundant
/// stop from here would only race that one for no benefit.
///
/// `@unchecked Sendable`: all mutable state is confined to `queue`, the
/// same discipline `CaptionUploader` uses.
final class AudioArchiveUploader: @unchecked Sendable {
    private let base: URL
    private let sessionID: String
    /// Resolves this device's bearer token — the same provider every relay
    /// client holds, resolved when a request is actually sent.
    private let token: @Sendable () async throws -> String
    private let session: URLSession
    private let queue = DispatchQueue(label: "audio.archive.uploader")

    /// PCM chunks awaiting the next post; whatever accumulates while a post
    /// is in flight goes up together as one batch, concatenated.
    private var pending: [Data] = []
    private var inFlight = false
    private var closed = false
    private let log = Logger(subsystem: "com.jonyen.watchcaptions", category: "AudioArchiveUploader")

    /// `sessionID` must be the exact id the sibling `CaptionUploader` for
    /// this same kept session uses, so both land under one relay session.
    init(
        sessionID: String,
        base: URL = RelayOrigin.http(from: Secrets.relayURL),
        token: @escaping @Sendable () async throws -> String
    ) {
        self.sessionID = sessionID
        self.base = base
        self.token = token
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 15   // fail a post rather than hang
        session = URLSession(configuration: config)
    }

    /// Nothing to open over HTTP: the relay creates (or reuses) the archive
    /// session lazily on the first post, the same way `/v1/audio` does.
    /// Kept so the engine's start sequence reads like its sibling uploader's.
    func connect() {}

    /// Queue one chunk of raw PCM. Safe to call from any thread; dropped
    /// silently (never retried, never logged — there is nothing to send)
    /// once `close()` has run.
    func send(_ audio: Data) {
        guard !audio.isEmpty else { return }
        queue.async { [weak self] in
            guard let self, !self.closed else { return }
            self.pending.append(audio)
            self.flushNext()
        }
    }

    /// Stop accepting new audio and flush whatever is still queued. Unlike
    /// `CaptionUploader.close()`, this posts no stop of its own — see the
    /// type doc comment.
    func close() {
        queue.async { [weak self] in
            guard let self, !self.closed else { return }
            self.closed = true
            self.flushNext()
        }
    }

    // MARK: - Internals (all run on `queue`)

    private func flushNext() {
        guard !inFlight, !pending.isEmpty else { return }
        let batch = Self.concat(pending)
        pending.removeAll()
        inFlight = true
        post(batch, retriesLeft: 1)
    }

    private func post(_ data: Data, retriesLeft: Int) {
        let token = self.token
        Task { [weak self] in
            let bearer: String
            do {
                bearer = try await token()
            } catch {
                self?.queue.async {
                    self?.attemptFailed(
                        data,
                        retriesLeft: retriesLeft,
                        reason: "could not resolve device token: \(error)")
                }
                return
            }
            guard let self else { return }
            self.queue.async {
                var req = URLRequest(url: self.url())
                req.httpMethod = "POST"
                req.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
                req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
                req.httpBody = data
                self.session.dataTask(with: req) { [weak self] _, response, error in
                    guard let self else { return }
                    self.queue.async {
                        guard error == nil, let http = response as? HTTPURLResponse,
                              http.statusCode == 200
                        else {
                            let status = (response as? HTTPURLResponse).map { "HTTP \($0.statusCode)" }
                            self.attemptFailed(
                                data,
                                retriesLeft: retriesLeft,
                                reason: error?.localizedDescription ?? status ?? "no response")
                            return
                        }
                        self.inFlight = false
                        self.flushNext()
                    }
                }.resume()
            }
        }
    }

    /// One attempt failed: try the batch once more, then drop it — logged,
    /// never surfaced to the caption path or the kept indicator. Later audio
    /// still gets its own attempt: a transient blip costs the bytes queued
    /// during it, not the rest of the session's archive.
    private func attemptFailed(_ data: Data, retriesLeft: Int, reason: String) {
        if retriesLeft > 0 {
            post(data, retriesLeft: retriesLeft - 1)
            return
        }
        log.error(
            "dropping \(data.count) byte(s) of archived audio after retry — \(reason, privacy: .public)")
        inFlight = false
        flushNext()
    }

    private func url() -> URL {
        var c = URLComponents(
            url: base.appendingPathComponent("v1/audio-archive"), resolvingAgainstBaseURL: false)!
        c.queryItems = [URLQueryItem(name: "session", value: sessionID)]
        return c.url!
    }

    private static func concat(_ chunks: [Data]) -> Data {
        var out = Data()
        for chunk in chunks { out.append(chunk) }
        return out
    }
}
