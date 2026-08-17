import Foundation

/// Copy this file to `Secrets.swift` (gitignored) and fill in real values.
/// Use the same relay origin as the Watch app. No auth token here anymore —
/// the app (and its upload extension) register themselves with the relay on
/// first launch and keep the token they're issued in the Keychain (see
/// `DeviceIdentity`).
enum Secrets {
    static let relayURL = URL(string: "https://YOUR-APP.fly.dev")!
}
