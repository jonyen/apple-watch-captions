import Foundation
import CaptionRelay

/// The real `PairingTransport`: a plain `URLSession`, matching
/// `RelayDeviceRegistrar`'s. Lives here rather than in the pure `CaptionRelay`
/// target for the same reason `RelayDeviceRegistrar` does — see that type's
/// header comment and `Package.swift`'s target split.
///
/// App code should construct `RelayPairingClient` through this initializer
/// (`base` + `token`, matching `RelayDeviceRegistrar` and `HTTPRelayClient`'s
/// call shape); `CaptionRelay`'s three-argument designated initializer, with
/// an injected `PairingTransport`, exists for tests.
public extension RelayPairingClient {
    /// `base` is the relay origin (e.g. `https://host`); `token` authorizes
    /// both `/v1/pair/code` and `/v1/pair/claim` requests.
    init(base: URL, token: @escaping @Sendable () async throws -> String) {
        let session = URLSession(configuration: .default)
        self.init(base: base, token: token, transport: { try await session.data(for: $0) })
    }
}
