import Foundation
import CaptionCore
import CaptionRelay

/// Reads the relay's current call over plain HTTP, the only networking
/// watchOS allows here (TN3135). Decoding lives in CaptionCore, where it is
/// unit-tested against the relay's real response shape.
struct RelayCallClient: CallClient {
    let base: URL
    let token: String

    /// Short timeout on purpose: this runs on every foreground to decide
    /// whether to open call captions, so an unreachable relay has to fail fast
    /// and let the app land on the menu rather than hang. 2s rather than 5s —
    /// this gates every launch, and 5s of stall on an unreachable relay was
    /// too much to pay just to find the menu.
    private static let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 2
        return URLSession(configuration: config)
    }()

    func poll(since: Int, ready: Bool) async throws -> CallUpdate {
        var components = URLComponents(
            url: base.appendingPathComponent("v1/call"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "token", value: token),
            URLQueryItem(name: "since", value: String(since)),
        ]
        // Only a poll from the call screen claims presence. The relay hands an
        // inbound call to the watch on the strength of this alone, so the
        // launch probe — which runs whatever the user opened the app for —
        // deliberately omits it.
        if ready { components.queryItems?.append(URLQueryItem(name: "ready", value: "1")) }
        let (data, response) = try await Self.session.data(from: components.url!)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw HistoryError.message("Relay error")
        }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw HistoryError.message("Unreadable response")
        }
        return decodeCallUpdate(json)
    }

    /// Hang up. Twilio holds the call for exactly as long as the relay's
    /// WebSocket lives, and the watch is not a party to that socket — so this
    /// is the only thing that ends a call. Without it the caller stays
    /// connected to silence, billed, until they give up.
    ///
    /// A 409 means there was nothing to end (the caller already hung up, or
    /// the phone holds this one). That is the outcome the caller wanted, so
    /// it is not an error.
    func end() async throws {
        var components = URLComponents(
            url: base.appendingPathComponent("v1/call/end"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "token", value: token)]
        var request = URLRequest(url: components.url!)
        request.httpMethod = "POST"
        let (_, response) = try await Self.session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw HistoryError.message("Relay error")
        }
        guard http.statusCode == 200 || http.statusCode == 409 else {
            throw HistoryError.message("Relay error")
        }
    }
}
