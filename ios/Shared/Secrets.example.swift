import Foundation

/// Copy this file to `Secrets.swift` (gitignored) and fill in real values.
/// Use the same relay origin as the Watch app — this is where the phone's
/// forwarding store (kept sessions) posts transcripts.
enum Secrets {
    static let relayURL = URL(string: "https://YOUR-APP.fly.dev")!
}
