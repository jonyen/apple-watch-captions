import Foundation

/// Copy this file to `Secrets.swift` (gitignored) and fill in real values.
/// No auth token here anymore — the app registers itself with the relay on
/// first launch and keeps the token it's issued in the Keychain (see
/// `DeviceIdentity`).
enum Secrets {
    static let relayURL = URL(string: "wss://YOUR-APP.fly.dev/stream")!
}
