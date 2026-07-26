import Foundation
import CaptionCore

/// Reads and removes stored transcripts through the relay's `/v1/transcripts`
/// endpoints. Plain `URLSession` requests, the only networking watchOS allows
/// here. Decoding lives in CaptionCore, where it is unit-tested against the
/// relay's real response shape.
struct RelayHistoryClient: HistoryClient {
    let base: URL
    let token: String

    func list() async throws -> [TranscriptListItem] {
        try decodeTranscriptList(await get(name: nil))
    }

    func detail(name: String) async throws -> TranscriptDetail {
        decodeTranscriptDetail(try await get(name: name), name: name)
    }

    func delete(name: String) async throws {
        var request = URLRequest(url: endpoint(name: name))
        request.httpMethod = "DELETE"
        let (_, response) = try await URLSession.shared.data(for: request)
        try check(response)
    }

    private func get(name: String?) async throws -> [String: Any] {
        let (data, response) = try await URLSession.shared.data(from: endpoint(name: name))
        try check(response)
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw HistoryError.message("Unreadable response")
        }
        return json
    }

    private func endpoint(name: String?) -> URL {
        var url = base.appendingPathComponent("v1/transcripts")
        if let name { url = url.appendingPathComponent(name) }
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
