import Foundation
import CaptionCore

/// Reads settings and session presence from the relay over plain HTTP, the only
/// networking watchOS allows here (TN3135). Decoding lives in CaptionCore,
/// where it is unit-tested against the relay's real response shape.
struct RelaySettingsClient {
    let base: URL
    let token: String

    /// Short timeout on purpose: both of these gate a launch, so an unreachable
    /// relay has to fail fast and let the app land on the menu with defaults
    /// rather than hang on the way in. Same reasoning as `RelayCallClient`.
    private static let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 2
        return config.urlSession()
    }()

    /// Current settings, or defaults if the relay cannot be reached. Settings
    /// are a convenience; failing to open the app over one would not be.
    func settings() async -> Settings {
        guard let json = await get(path: "v1/settings", query: []) else { return .defaults }
        return decodeSettings(json)
    }

    /// Whether anything is feeding or reading `session` right now.
    func presence(session id: String) async -> Presence {
        let json = await get(path: "v1/presence",
                             query: [URLQueryItem(name: "session", value: id)])
        return json.map(decodePresence) ?? Presence()
    }

    private func get(path: String, query: [URLQueryItem]) async -> [String: Any]? {
        var components = URLComponents(
            url: base.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "token", value: token)] + query
        guard let url = components.url,
              let (data, response) = try? await Self.session.data(from: url),
              (response as? HTTPURLResponse)?.statusCode == 200
        else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }
}

private extension URLSessionConfiguration {
    func urlSession() -> URLSession { URLSession(configuration: self) }
}
