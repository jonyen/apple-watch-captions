import Foundation
import Security

/// Relay URL in UserDefaults; auth token in the Keychain.
final class SettingsStore: ObservableObject {
    private static let service = "com.jonyen.watchcaptions.mac"
    private static let account = "relay-token"

    @Published var relayURLString: String {
        didSet { UserDefaults.standard.set(relayURLString, forKey: "relayURL") }
    }
    @Published var token: String {
        didSet { Self.saveToken(token) }
    }

    init() {
        relayURLString = UserDefaults.standard.string(forKey: "relayURL") ?? ""
        token = Self.loadToken()
    }

    var relayURL: URL? { URL(string: relayURLString) }
    var configured: Bool { relayURL != nil && !token.isEmpty }

    private static func loadToken() -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return "" }
        return String(data: data, encoding: .utf8) ?? ""
    }

    private static func saveToken(_ token: String) {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(base as CFDictionary)
        guard !token.isEmpty else { return }
        var add = base
        add[kSecValueData as String] = Data(token.utf8)
        SecItemAdd(add as CFDictionary, nil)
    }
}
