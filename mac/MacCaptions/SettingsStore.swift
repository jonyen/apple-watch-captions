import Foundation

/// Overlay preferences, UserDefaults-backed.
final class SettingsStore: ObservableObject {
    static let defaultFontSize: Double = 18

    /// Overlay caption text size in points.
    @Published var fontSize: Double {
        didSet { UserDefaults.standard.set(fontSize, forKey: "captionFontSize") }
    }

    init() {
        let storedSize = UserDefaults.standard.double(forKey: "captionFontSize")
        fontSize = storedSize > 0 ? storedSize : Self.defaultFontSize
    }
}
