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

struct UsageDeepgram: Codable {
    let hours: Double
    let requests: Int
}

struct UsageFlyMachine: Codable, Identifiable {
    let id: String
    let state: String
    let region: String
}

struct UsageFly: Codable {
    let appName: String
    let machines: [UsageFlyMachine]?
    let machinesError: String?
    let monthlyCostUsd: Double
}

struct UsageReport: Codable {
    let rangeStart: String
    let rangeEnd: String
    let deepgram: UsageDeepgram?
    let deepgramError: String?
    let deepgramRatePerMin: Double
    let fly: UsageFly

    var estimatedDeepgramCost: Double? {
        deepgram.map { $0.hours * 60 * deepgramRatePerMin }
    }
}

/// Thin client for the relay's transcript and usage endpoints.
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

    func usage() async throws -> UsageReport {
        try await get(path: "v1/usage", as: UsageReport.self)
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
