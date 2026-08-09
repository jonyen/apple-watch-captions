import Foundation
import CaptionCore

/// The relay's call-audio endpoints. Binary bodies rather than base64 in JSON:
/// a third less data on a link that is already the bottleneck.
struct RelayCallAudioClient: CallAudioClient, CallVoiceClient {
    let base: URL
    let token: String

    private static let session: URLSession = {
        let config = URLSessionConfiguration.default
        // Audio is worthless late; failing fast and polling again beats waiting.
        config.timeoutIntervalForRequest = 5
        return URLSession(configuration: config)
    }()

    func fetch(since: Int) async throws -> AudioChunk {
        var components = URLComponents(
            url: base.appendingPathComponent("v1/call/audio"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "token", value: token),
            URLQueryItem(name: "since", value: String(since)),
        ]
        let (data, response) = try await Self.session.data(from: components.url!)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw HistoryError.message("Relay error")
        }
        let seq = Int(http.value(forHTTPHeaderField: "X-Seq") ?? "") ?? since
        return AudioChunk(samples: MuLaw.decode(data), seq: seq)
    }

    func send(_ pcm: Data) async throws {
        var components = URLComponents(
            url: base.appendingPathComponent("v1/call/audio"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "token", value: token)]
        var request = URLRequest(url: components.url!)
        request.httpMethod = "POST"
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        request.httpBody = pcm
        let (_, response) = try await Self.session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw HistoryError.message("Relay error")
        }
        switch http.statusCode {
        case 204:
            return
        case 409:
            // The relay refuses this deliberately when no call is live
            // (backend/src/server.call.test.ts: "Nothing to speak into:
            // better a clear refusal than silently dropping it"). Kept as
            // its own case, not folded into HistoryError.message, so a
            // caller can tell "the call ended, stop trying" apart from a
            // transient failure worth retrying.
            throw CallVoiceError.noCallLive
        default:
            throw HistoryError.message("Relay error")
        }
    }
}

/// Distinguishes the relay's deliberate "no call is live" refusal (409) from
/// other send failures — see the doc comment on `send(_:)`.
enum CallVoiceError: Error, Equatable {
    case noCallLive
}
