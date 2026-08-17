import Foundation
import Security
import os
import CaptionRelay

/// Persists the relay device token in the Keychain, so it survives app
/// relaunches — and a reboot before the device has been unlocked once, since
/// registration has to succeed regardless: a watch coming off the charger or
/// a phone waking for a background refresh can both hit this before the
/// wearer has unlocked anything — without living in UserDefaults, which is
/// unencrypted app storage.
///
/// One generic-password item, keyed by this app's bundle id plus a fixed
/// suffix so it cannot collide with another app's Keychain entry, and a fixed
/// account since there is only ever one token per install.
///
/// `service` and `accessGroup` are overridable for the one case where two
/// separate targets must resolve to the *same* item: an app and its
/// extension. `Bundle.main.bundleIdentifier` differs between an app and its
/// extension process (different bundle id), so the default service string
/// alone would mint two Keychain items instead of sharing one — and without
/// an explicit `accessGroup` (via a Keychain Sharing entitlement both
/// targets declare), the extension cannot read the app's item at all,
/// regardless of the service string. Pass both explicitly when that sharing
/// is required; the defaults are unchanged for a single-target app.
public struct KeychainTokenStore: SecureTokenStore {
    private let service: String
    private let account = "device-token"
    private let accessGroup: String?

    private static let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "device-identity", category: "keychain")

    public init(service: String? = nil, accessGroup: String? = nil) {
        self.service = service ?? (Bundle.main.bundleIdentifier ?? "device-identity") + ".relay-device-token"
        self.accessGroup = accessGroup
    }

    public func read() -> String? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func write(_ token: String) {
        guard let data = token.data(using: .utf8) else { return }

        var addQuery = baseQuery()
        addQuery[kSecValueData as String] = data
        // AfterFirstUnlock, not WhenUnlocked: registration can happen before
        // the device has been unlocked once since a reboot, and it still has
        // to succeed.
        addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock

        let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
        if addStatus == errSecSuccess { return }

        guard addStatus == errSecDuplicateItem else {
            Self.logger.error("Keychain add failed: \(addStatus)")
            return
        }
        // An item is already there from a previous registration — a plain
        // SecItemAdd would have returned errSecDuplicateItem and silently not
        // stored the new value, so replace the existing value instead.
        let updateStatus = SecItemUpdate(
            baseQuery() as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if updateStatus != errSecSuccess {
            Self.logger.error("Keychain update failed: \(updateStatus)")
        }
    }

    private func baseQuery() -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }
}
