import Foundation
import CaptionRelay

/// The relay's call-audio endpoints. Binary bodies rather than base64 in JSON:
/// a third less data on a link that is already the bottleneck.
struct RelayCallAudioClient: CallAudioClient, CallVoiceClient {
    let base: URL
    /// Resolves this device's bearer token from `DeviceIdentity`. A provider
    /// rather than a stored `String` — see `HTTPRelayClient`.
    let token: @Sendable () async throws -> String

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
            URLQueryItem(name: "since", value: String(since)),
        ]
        var request = URLRequest(url: components.url!)
        request.setValue("Bearer \(try await token())", forHTTPHeaderField: "Authorization")
        let (data, response) = try await Self.session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw HistoryError.message("Relay error")
        }
        let seq = Int(http.value(forHTTPHeaderField: "X-Seq") ?? "") ?? since
        return AudioChunk(samples: MuLaw.decode(data), seq: seq)
    }

    func send(_ pcm: Data) async throws {
        var request = URLRequest(url: base.appendingPathComponent("v1/call/audio"))
        request.httpMethod = "POST"
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(try await token())", forHTTPHeaderField: "Authorization")
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
            // better a clear refusal than silently dropping it"), and also
            // on the captions-only fallback, where the phone holds the call.
            // `CallVoice.endTalking` hands this back to `AppModel`, which
            // says so on screen — the user is otherwise left pressing and
            // speaking into a call that cannot hear them.
            throw CallVoiceError.noCallLive
        default:
            throw HistoryError.message("Relay error")
        }
    }
}
