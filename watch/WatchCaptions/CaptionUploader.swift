import Foundation
import os

/// Posts caption lines to the relay's `/v1/captions` endpoint, so a session
/// whose captions are computed on the watch still leaves a transcript on the
/// relay.
///
/// HTTP, not the `/stream` WebSocket the relay also accepts caption frames
/// on: watchOS blocks WebSockets for normal apps (TN3135) — the very reason
/// `HTTPRelayClient` talks HTTP — so this client mirrors that shape instead.
/// A client-minted session id names the relay session (`?session=`, same as
/// the audio path), each post carries the bearer token, the relay creates
/// the session lazily on the first post, and `close()` posts `/v1/stop`,
/// which finalizes the transcript exactly as it does for an audio session
/// (the relay's idle timeout finalizes it anyway if the stop never arrives).
///
/// The write half only: no audio ever goes up, and the response is read for
/// just two fields — the `transcript` name (reported once through
/// `onTranscript`, so the app can offer to resume the transcript later; the
/// old WebSocket path could never learn it) and the `seq` cursor, echoed
/// back as `since` so the relay prunes its event buffer. The local engine is
/// the source of truth for the screen.
///
/// Failure here is lost persistence, never a session error: captions keep
/// coming from the local engine either way. Lines queue in memory while a
/// post is in flight and go up as one batch; a batch that fails is retried
/// once and then dropped with a log line, with `onKept` reporting the
/// downgrade so the captions screen falls back to its not-saved indicator.
/// Later lines still get their own attempt — a transient blip costs the
/// lines queued during it, not the rest of the transcript — and a later
/// acknowledged post flips the indicator back.
///
/// `@unchecked Sendable`: all mutable state is confined to `queue`, the same
/// discipline as `HTTPRelayClient`.
final class CaptionUploader: @unchecked Sendable {
    /// Reports whether lines are reaching the relay: true after each
    /// acknowledged post that carried lines, false again when a batch is
    /// dropped. Never fires for a clean `close()`.
    var onKept: (@MainActor (Bool) -> Void)?
    /// Fires once with the transcript this session is writing to, when the
    /// relay first names it (its first response after a final line landed).
    var onTranscript: (@MainActor (String) -> Void)?

    private struct Line {
        let text: String
        let isFinal: Bool
    }

    private let base: URL
    /// Resolves this device's bearer token — the same provider every relay
    /// client holds, resolved when a request is actually sent.
    private let token: @Sendable () async throws -> String
    private let session: URLSession
    private let queue = DispatchQueue(label: "caption.uploader")

    /// This session's relay name — minted per uploader, one uploader per
    /// session, the same way `HTTPRelayClient` mints one per connect. Not
    /// private: `SavedOnDeviceEngine` reads it to hand the exact same id to
    /// this session's `AudioArchiveUploader`, so archived audio and uploaded
    /// captions land under one relay session.
    let sessionID = UUID().uuidString
    /// Lines awaiting the next post; whatever accumulates while a post is in
    /// flight goes up together as one batch.
    private var pending: [Line] = []
    private var inFlight = false
    private var closed = false
    private var stopSent = false
    private var kept = false
    private var transcriptDelivered = false
    private var lastSeq = 0
    private let log = Logger(subsystem: "com.jonyen.watchcaptions", category: "CaptionUploader")

    /// `base` is the relay's HTTP(S) origin — derived from `Secrets.relayURL`
    /// the same way every other relay client derives it; `token` authorizes
    /// each request.
    init(
        base: URL = RelayOrigin.http(from: Secrets.relayURL),
        token: @escaping @Sendable () async throws -> String
    ) {
        self.base = base
        self.token = token
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 15   // fail a post rather than hang
        session = URLSession(configuration: config)
    }

    /// Nothing to open over HTTP: the relay creates the session lazily on the
    /// first post, the same way `/v1/audio` does for an audio session. Kept
    /// so the engine's start sequence reads like the other relay clients'.
    func connect() {}

    /// Queue one caption line. Safe to call from any thread; dropped silently
    /// once `close()` has run.
    func send(text: String, isFinal: Bool) {
        queue.async { [weak self] in
            guard let self, !self.closed else { return }
            self.pending.append(Line(text: text, isFinal: isFinal))
            self.flushNext()
        }
    }

    /// Flush whatever is still queued, then post `/v1/stop` — which is what
    /// tells the relay the session is over: it finalizes the transcript, the
    /// same call `HTTPRelayClient` ends its sessions with.
    func close() {
        queue.async { [weak self] in
            guard let self, !self.closed else { return }
            self.closed = true
            self.flushNext()
        }
    }

    // MARK: - Internals (all run on `queue`)

    /// Post the queued lines if nothing is in flight; once closed and
    /// drained, post the stop instead. Every completion path funnels back
    /// here, so the stop can never overtake a caption post — a stop arriving
    /// first would finalize the transcript before its last line, and a post
    /// arriving after would lazily recreate the session it just released.
    private func flushNext() {
        guard !inFlight else { return }
        if pending.isEmpty {
            if closed, !stopSent {
                stopSent = true
                sendStop()
            }
            return
        }
        let batch = pending
        pending.removeAll()
        inFlight = true
        post(batch, retriesLeft: 1)
    }

    private func post(_ batch: [Line], retriesLeft: Int) {
        let token = self.token
        Task { [weak self] in
            let bearer: String
            do {
                bearer = try await token()
            } catch {
                self?.queue.async {
                    self?.attemptFailed(
                        batch,
                        retriesLeft: retriesLeft,
                        reason: "could not resolve device token: \(error)")
                }
                return
            }
            guard let self else { return }
            self.queue.async {
                var req = URLRequest(url: self.url(path: "v1/captions", since: self.lastSeq))
                req.httpMethod = "POST"
                req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                req.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
                req.httpBody = Self.body(for: batch)
                self.session.dataTask(with: req) { [weak self] data, response, error in
                    guard let self else { return }
                    self.queue.async {
                        guard error == nil, let data,
                              let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                            let status = (response as? HTTPURLResponse).map { "HTTP \($0.statusCode)" }
                            self.attemptFailed(
                                batch,
                                retriesLeft: retriesLeft,
                                reason: error?.localizedDescription ?? status ?? "no response")
                            return
                        }
                        self.posted(batch, response: data)
                    }
                }.resume()
            }
        }
    }

    /// An acknowledged post: the relay stored the batch. Note the seq cursor
    /// and the transcript name, flip the indicator, and keep draining.
    private func posted(_ batch: [Line], response data: Data) {
        inFlight = false
        if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if let seq = obj["seq"] as? Int { lastSeq = max(lastSeq, seq) }
            if let name = obj["transcript"] as? String, !transcriptDelivered {
                transcriptDelivered = true
                if let onTranscript { Task { @MainActor in onTranscript(name) } }
            }
        }
        // Only a post that carried lines proves the transcript is being kept;
        // this also flips the indicator back after an earlier dropped batch.
        if !batch.isEmpty, !kept {
            kept = true
            deliverKept(true)
        }
        flushNext()
    }

    /// One attempt failed: try the batch once more, then drop it. Dropping is
    /// lost persistence, quietly — log, downgrade the indicator via `onKept`,
    /// and move on to whatever queued since (or the stop). The session itself
    /// is never touched.
    private func attemptFailed(_ batch: [Line], retriesLeft: Int, reason: String) {
        if retriesLeft > 0 {
            post(batch, retriesLeft: retriesLeft - 1)
            return
        }
        log.error(
            "dropping \(batch.count) caption line(s) after retry — \(reason, privacy: .public)")
        inFlight = false
        if kept {
            kept = false
            deliverKept(false)
        }
        flushNext()
    }

    /// Best-effort release, exactly like `HTTPRelayClient.close()`: the relay
    /// finalizes on its idle timeout anyway if this never lands.
    private func sendStop() {
        let url = url(path: "v1/stop")
        let token = self.token
        let session = self.session
        Task {
            guard let bearer = try? await token() else { return }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
            session.dataTask(with: req).resume()
        }
    }

    /// Build a request URL for this session, optionally with a `since` cursor.
    private func url(path: String, since: Int? = nil) -> URL {
        var c = URLComponents(
            url: base.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        var items = [URLQueryItem(name: "session", value: sessionID)]
        if let since { items.append(URLQueryItem(name: "since", value: String(since))) }
        c.queryItems = items
        return c.url!
    }

    /// `{"lines":[{"text":"…","isFinal":true}, …]}` — the endpoint's batch
    /// shape, one-or-more lines per post.
    private static func body(for batch: [Line]) -> Data {
        let lines = batch.map { ["text": $0.text, "isFinal": $0.isFinal] as [String: Any] }
        return (try? JSONSerialization.data(withJSONObject: ["lines": lines]))
            ?? Data(#"{"lines":[]}"#.utf8)
    }

    private func deliverKept(_ kept: Bool) {
        if let onKept { Task { @MainActor in onKept(kept) } }
    }
}
