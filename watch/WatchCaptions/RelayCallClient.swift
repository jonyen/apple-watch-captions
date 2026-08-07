import Foundation
import CaptionCore

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

    func poll(since: Int) async throws -> CallUpdate {
        var components = URLComponents(
            url: base.appendingPathComponent("v1/call"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "token", value: token),
            URLQueryItem(name: "since", value: String(since)),
        ]
        let (data, response) = try await Self.session.data(from: components.url!)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw HistoryError.message("Relay error")
        }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw HistoryError.message("Unreadable response")
        }
        return decodeCallUpdate(json)
    }
}
