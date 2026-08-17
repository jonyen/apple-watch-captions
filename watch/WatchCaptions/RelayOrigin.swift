import Foundation

/// Derives the relay's plain-HTTP(S) origin from `Secrets.relayURL`, which on
/// the Watch is a `wss://…/stream` WebSocket URL — the transport is blocked
/// for normal watchOS apps (TN3135), so every client here talks HTTP instead
/// and needs this conversion once, shared rather than repeated per client.
enum RelayOrigin {
    /// The HTTPS origin (e.g. `https://host`) for `relayURL`, with its path
    /// and query dropped.
    static func http(from relayURL: URL) -> URL {
        var components = URLComponents(url: relayURL, resolvingAgainstBaseURL: false)!
        components.scheme = "https"
        components.path = ""
        components.query = nil
        return components.url!
    }
}
