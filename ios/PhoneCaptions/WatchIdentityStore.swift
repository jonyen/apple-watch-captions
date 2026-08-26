import Foundation
import CaptionRelayLive

/// Keychain-backed home for the watch's bearer token on the phone, shared
/// once per watch app launch over WatchConnectivity (`PhoneWire.shareIdentity`,
/// received in `WCTranscriberService`) so this phone can read the watch's own
/// transcripts and summaries from the relay through `RelayHistoryClient`.
///
/// Wraps `KeychainTokenStore` (the same Keychain plumbing every other
/// relay-facing identity in this codebase uses) rather than reimplementing
/// it, with its own `service` string so this item can never collide with —
/// or be confused for — any identity this app registers for itself.
///
/// Per the design's token-hygiene rule: this is the *only* place the watch's
/// token lives on the phone besides an in-flight request. Never logged,
/// never mirrored into UserDefaults or a file.
enum WatchIdentityStore {
    static let shared = KeychainTokenStore(
        service: (Bundle.main.bundleIdentifier ?? "com.jonyen.phonecaptions") + ".watch-identity-token")

    static func read() -> String? { shared.read() }
    static func write(_ token: String) { shared.write(token) }
    static func clear() { shared.clear() }
}
