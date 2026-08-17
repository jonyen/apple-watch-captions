import Foundation
import CaptionRelay
import CaptionRelayLive

/// This device's identity with the relay: a bearer token issued once at
/// first launch and kept in the Keychain from then on. `DeviceRegistration`
/// is an actor, so concurrent early callers — more than one call site at
/// launch — coalesce onto the same in-flight registration instead of each
/// minting a separate device.
///
/// Shared between `PhoneCaptions` and `PhoneCaptionsUpload`, not just the
/// main app: the broadcast extension is a separate OS process with its own
/// `Bundle.main`, so it cannot resolve as "the same phone" by accident. Two
/// things make that possible instead of each target registering (and being
/// billed and captioned) as its own unpaired device:
///
///   - A literal, fixed Keychain service string, rather than
///     `KeychainTokenStore`'s bundle-id-derived default — the app and the
///     extension have different bundle ids, so the default would already
///     diverge between them even before access groups enter into it.
///   - A Keychain Sharing entitlement (`keychain-access-groups`) both
///     targets declare with the same group id (see `ios/project.yml`),
///     without which the extension's Keychain queries cannot see an item
///     the app wrote (and vice versa) regardless of the service string.
///
/// Whichever target launches first registers; the other reads the same
/// stored token from then on. This is the one piece of this feature that
/// depends on a provisioning capability the project has not needed before —
/// worth confirming on-device (Task 8), the same as the Keychain store
/// itself.
enum DeviceIdentity {
    /// Fixed rather than derived from `Bundle.main.bundleIdentifier`, which
    /// would otherwise disagree between the app (`com.jonyen.phonecaptions`)
    /// and the extension (`com.jonyen.phonecaptions.upload`).
    private static let keychainService = "com.jonyen.phonecaptions.relay-device-token"
    /// Must match the `keychain-access-groups` entitlement in both targets'
    /// `project.yml` blocks exactly, including the `7PZN69YDL4` team prefix
    /// — `$(AppIdentifierPrefix)` is an Xcode build setting substituted into
    /// the compiled entitlements plist, not a runtime string, so the Swift
    /// side has to spell out what that substitution resolves to.
    private static let keychainAccessGroup = "7PZN69YDL4.com.jonyen.phonecaptions.shared"

    static let shared = DeviceRegistration(
        kind: "phone",
        store: KeychainTokenStore(service: keychainService, accessGroup: keychainAccessGroup),
        registrar: RelayDeviceRegistrar(base: Secrets.relayURL)
    )
}
