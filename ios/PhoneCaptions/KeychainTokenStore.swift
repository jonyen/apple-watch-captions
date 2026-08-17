import Foundation
import Security
import os
import CaptionRelay

/// Persists the relay device token in the Keychain, so it survives app
/// relaunches without living in UserDefaults, which is unencrypted app
/// storage.
///
/// One generic-password item, keyed by this app's bundle id plus a fixed
/// suffix so it cannot collide with another app's Keychain entry, and a fixed
/// account since there is only ever one token per install.
struct KeychainTokenStore: SecureTokenStore {
    private let service: String
    private let account = "device-token"

    private static let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "device-identity", category: "keychain")

    init() {
        service = (Bundle.main.bundleIdentifier ?? "device-identity") + ".relay-device-token"
    }

    func read() -> String? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func write(_ token: String) {
        guard let data = token.data(using: .utf8) else { return }

        var addQuery = baseQuery()
        addQuery[kSecValueData as String] = data
        // AfterFirstUnlock, not WhenUnlocked: registration can happen from a
        // background refresh before the phone has been unlocked once since a
        // reboot, and it still has to succeed.
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
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}
