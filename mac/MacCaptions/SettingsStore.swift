import Foundation
import Security

/// A captioning engine the app can run. Cloud providers go through the relay
/// (which needs the matching API key); `apple` runs on-device with no relay.
enum CaptionProvider: String, CaseIterable, Identifiable {
    case deepgram
    case apple
    case openai
    case assemblyai

    var id: String { rawValue }
    var displayName: String {
        switch self {
        case .deepgram: return "Deepgram"
        case .apple: return "Apple (on-device)"
        case .openai: return "OpenAI"
        case .assemblyai: return "AssemblyAI"
        }
    }
    var needsRelay: Bool { self != .apple }
}

/// Relay URL in UserDefaults; auth token in the Keychain.
final class SettingsStore: ObservableObject {
    private static let service = "com.jonyen.watchcaptions.mac"
    private static let account = "relay-token"
    static let defaultFontSize: Double = 18

    @Published var relayURLString: String {
        didSet { UserDefaults.standard.set(relayURLString, forKey: "relayURL") }
    }
    @Published var token: String {
        didSet { Self.saveToken(token) }
    }
    /// Overlay caption text size in points.
    @Published var fontSize: Double {
        didSet { UserDefaults.standard.set(fontSize, forKey: "captionFontSize") }
    }
    /// Engine used in single-provider mode.
    @Published var provider: CaptionProvider {
        didSet { UserDefaults.standard.set(provider.rawValue, forKey: "captionProvider") }
    }
    /// Compare mode: run every provider at once, one overlay pane per provider.
    @Published var compareProviders: Bool {
        didSet { UserDefaults.standard.set(compareProviders, forKey: "compareProviders") }
    }

    init() {
        relayURLString = UserDefaults.standard.string(forKey: "relayURL") ?? ""
        token = Self.loadToken()
        let storedSize = UserDefaults.standard.double(forKey: "captionFontSize")
        fontSize = storedSize > 0 ? storedSize : Self.defaultFontSize
        provider = UserDefaults.standard.string(forKey: "captionProvider")
            .flatMap(CaptionProvider.init(rawValue:)) ?? .deepgram
        compareProviders = UserDefaults.standard.bool(forKey: "compareProviders")
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
