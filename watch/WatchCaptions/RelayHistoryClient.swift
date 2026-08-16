import Foundation
import CaptionRelay

/// Reads and removes stored transcripts through the relay's `/v1/transcripts`
/// endpoints. Plain `URLSession` requests, the only networking watchOS allows
/// here. Decoding lives in CaptionCore, where it is unit-tested against the
/// relay's real response shape.
struct RelayHistoryClient: HistoryClient, ExportStatusClient {
    let base: URL
    let token: String

    func list() async throws -> [TranscriptListItem] {
        try decodeTranscriptList(await get())
    }

    func detail(name: String) async throws -> TranscriptDetail {
        decodeTranscriptDetail(try await get(name), name: name)
    }

    /// Whether this transcript has reached Notion. Its own endpoint rather than
    /// `detail`, which would ship every caption back on each poll.
    func exportStatus(name: String) async throws -> ExportStatus {
        let (data, response) = try await URLSession.shared.data(from: endpoint(name, "export"))
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
        let (_, response) = try await URLSession.shared.data(for: request)
        try check(response)
    }

    private func get(_ path: String...) async throws -> [String: Any] {
        let (data, response) = try await URLSession.shared.data(from: endpoint(path))
        try check(response)
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw HistoryError.message("Unreadable response")
        }
        return json
    }

    private func endpoint(_ path: String...) -> URL {
        endpoint(path)
    }

    private func endpoint(_ path: [String]) -> URL {
        var url = base.appendingPathComponent("v1/transcripts")
        for component in path { url = url.appendingPathComponent(component) }
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "token", value: token)]
        return components.url!
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
