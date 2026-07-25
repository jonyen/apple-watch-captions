import Foundation
import CaptionCore

/// Reads stored transcripts from the relay's `/v1/transcripts` endpoints.
/// Plain `URLSession` requests, the only networking watchOS allows here.
struct RelayHistoryClient: HistoryFetching {
    let base: URL
    let token: String

    func list() async throws -> [TranscriptListItem] {
        let json = try await get(path: "v1/transcripts", name: nil)
        guard let entries = json["transcripts"] as? [[String: Any]] else {
            throw HistoryError.message("Unexpected response")
        }
        return entries.compactMap { entry in
            guard let name = entry["name"] as? String else { return nil }
            return TranscriptListItem(
                name: name,
                title: entry["title"] as? String,
                startedAt: entry["startedAt"] as? String ?? "",
                segmentCount: entry["segmentCount"] as? Int ?? 0,
                hasSummary: entry["hasSummary"] as? Bool ?? false)
        }
    }

    func detail(name: String) async throws -> TranscriptDetail {
        let json = try await get(path: "v1/transcripts", name: name)
        let segments = (json["segments"] as? [[String: Any]] ?? []).map { segment in
            TranscriptSegment(text: segment["text"] as? String ?? "",
                              channel: segment["channel"] as? Int)
        }
        return TranscriptDetail(name: name, summary: json["summary"] as? String, segments: segments)
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
