import Foundation
import CaptionRelay

/// This device's identity with the relay: a bearer token issued once at
/// first launch and kept in the Keychain from then on. `DeviceRegistration`
/// is an actor, so concurrent early callers — more than one call site at
/// launch — coalesce onto the same in-flight registration instead of each
/// minting a separate device.
enum DeviceIdentity {
    static let shared = DeviceRegistration(
        kind: "watch",
        store: KeychainTokenStore(),
        registrar: RelayDeviceRegistrar(base: httpBase(from: Secrets.relayURL))
    )

    /// Derive the HTTPS origin (e.g. `https://host`) from the configured
    /// relay URL, which on the Watch is a `wss://…/stream` websocket URL.
    /// Mirrors `AppModel.httpBase(from:)`, which is private to `AppModel` —
    /// duplicated rather than shared because it is four lines and this is the
    /// only other place that needs it.
    private static func httpBase(from relayURL: URL) -> URL {
        var components = URLComponents(url: relayURL, resolvingAgainstBaseURL: false)!
        components.scheme = "https"
        components.path = ""
        components.query = nil
        return components.url!
    }
}
