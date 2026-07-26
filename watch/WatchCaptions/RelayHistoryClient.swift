import Foundation
import CaptionCore

/// Reads stored transcripts from the relay's `/v1/transcripts` endpoints.
/// Plain `URLSession` requests, the only networking watchOS allows here.
/// Decoding lives in CaptionCore, where it is unit-tested against the relay's
/// real response shape.
struct RelayHistoryClient: HistoryFetching {
    let base: URL
    let token: String

    func list() async throws -> [TranscriptListItem] {
        try decodeTranscriptList(await get(path: "v1/transcripts", name: nil))
    }

    func detail(name: String) async throws -> TranscriptDetail {
        decodeTranscriptDetail(try await get(path: "v1/transcripts", name: name), name: name)
    }

    private func get(path: String, name: String?) async throws -> [String: Any] {
        var url = base.appendingPathComponent(path)
        if let name { url = url.appendingPathComponent(name) }
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "token", value: token)]

        let (data, response) = try await URLSession.shared.data(from: components.url!)
        guard let http = response as? HTTPURLResponse else {
            throw HistoryError.message("No response")
        }
        guard http.statusCode == 200 else {
            throw HistoryError.message(http.statusCode == 401
                ? "Not authorized"
                : "Relay error \(http.statusCode)")
        }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw HistoryError.message("Unreadable response")
        }
        return json
    }
}
