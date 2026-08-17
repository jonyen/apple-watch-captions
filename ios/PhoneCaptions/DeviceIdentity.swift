import Foundation
import CaptionRelay
import CaptionRelayLive

/// This device's identity with the relay: a bearer token issued once at
/// first launch and kept in the Keychain from then on. `DeviceRegistration`
/// is an actor, so concurrent early callers — more than one call site at
/// launch — coalesce onto the same in-flight registration instead of each
/// minting a separate device.
enum DeviceIdentity {
    static let shared = DeviceRegistration(
        kind: "phone",
        store: KeychainTokenStore(),
        registrar: RelayDeviceRegistrar(base: Secrets.relayURL)
    )
}
