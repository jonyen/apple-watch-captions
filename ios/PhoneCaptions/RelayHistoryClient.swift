import Foundation
import CaptionRelay

/// Reads and removes stored transcripts through the relay's `/v1/transcripts`
/// endpoints. Plain `URLSession` requests — this is a straight copy of
/// `watch/WatchCaptions/RelayHistoryClient.swift` (same endpoints, same
/// decoding, both against `CaptionRelay`'s `HistoryClient`/`ExportStatusClient`
/// protocols); it lives in this app's target rather than a shared module
/// because it has no watchOS dependency to begin with, and duplicating one
/// small, already-tested file is a smaller change than restructuring the
/// package/build graph both apps share. Keep the two in sync by hand.
struct RelayHistoryClient: HistoryClient, ExportStatusClient {
    let base: URL
    /// Resolves the identity to authenticate as. On the phone this reads
    /// `WatchIdentityStore` — the watch's own bearer token, shared over
    /// WatchConnectivity — since the transcripts being browsed here are the
    /// watch's, not this app's own.
    let token: @Sendable () async throws -> String

    func list() async throws -> [TranscriptListItem] {
        try decodeTranscriptList(await get())
    }

    func detail(name: String) async throws -> TranscriptDetail {
        decodeTranscriptDetail(try await get(name), name: name)
    }

    /// Whether this transcript has reached Notion. Its own endpoint rather than
    /// `detail`, which would ship every caption back on each poll.
    func exportStatus(name: String) async throws -> ExportStatus {
        let (data, response) = try await send(URLRequest(url: endpoint(name, "export")))
        // A transcript the relay has never heard of will not turn up later — a
        // session that captured nothing writes no transcript at all. Report it
        // as unavailable so the wait ends, rather than throwing, which reads as
        // a transient failure and keeps polling to the end of the window.
        if (response as? HTTPURLResponse)?.statusCode == 404 { return .unavailable }
        try check(response)
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw HistoryError.message("Unreadable response")
        }
        return decodeExportStatus(json)
    }

    func delete(name: String) async throws {
        var request = URLRequest(url: endpoint(name))
        request.httpMethod = "DELETE"
        let (_, response) = try await send(request)
        try check(response)
    }

    private func get(_ path: String...) async throws -> [String: Any] {
        let (data, response) = try await send(URLRequest(url: endpoint(path)))
        try check(response)
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw HistoryError.message("Unreadable response")
        }
        return json
    }

    private func send(_ request: URLRequest) async throws -> (Data, URLResponse) {
        var request = request
        request.setValue("Bearer \(try await token())", forHTTPHeaderField: "Authorization")
        return try await URLSession.shared.data(for: request)
    }

    private func endpoint(_ path: String...) -> URL {
        endpoint(path)
    }

    private func endpoint(_ path: [String]) -> URL {
        var url = base.appendingPathComponent("v1/transcripts")
        for component in path { url = url.appendingPathComponent(component) }
        return url
    }

    private func check(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else {
            throw HistoryError.message("No response")
        }
        guard http.statusCode == 200 else {
            throw HistoryError.message(http.statusCode == 401
                ? "Not authorized"
                : "Relay error \(http.statusCode)")
        }
    }
}
