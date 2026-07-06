import Foundation

struct TranscriptSummary: Codable, Identifiable {
    let name: String
    let startedAt: String
    let segmentCount: Int
    let preview: String
    let hasSummary: Bool
    var id: String { name }
}

struct TranscriptSegment: Codable, Identifiable {
    let at: String
    let text: String
    let channel: Int?
    var id: String { at + text }
}

struct TranscriptDetail: Codable {
    let name: String
    let segments: [TranscriptSegment]
    let summary: String?
}

/// Thin client for the relay's transcript endpoints.
struct RelayAPI {
    let base: URL
    let token: String

    private struct ListResponse: Codable { let transcripts: [TranscriptSummary] }

    func list() async throws -> [TranscriptSummary] {
        try await get(path: "v1/transcripts", as: ListResponse.self).transcripts
    }

    func detail(name: String) async throws -> TranscriptDetail {
        try await get(path: "v1/transcripts/\(name)", as: TranscriptDetail.self)
    }

    private func get<T: Codable>(path: String, as type: T.Type) async throws -> T {
        var c = URLComponents(url: base.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        c.queryItems = [URLQueryItem(name: "token", value: token)]
        let (data, response) = try await URLSession.shared.data(from: c.url!)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
