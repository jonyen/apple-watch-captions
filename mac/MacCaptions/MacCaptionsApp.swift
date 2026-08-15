import SwiftUI
import CaptionCore

/// Reopen events (Spotlight/Finder launching the already-running app) have no
/// SwiftUI hook, so a minimal delegate forwards them to the model.
final class AppDelegate: NSObject, NSApplicationDelegate {
    @MainActor static var onReopen: (() -> Void)?

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        Task { @MainActor in AppDelegate.onReopen?() }
        return false
    }
}

@main
struct MacCaptionsApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model = AppModel()
    @Environment(\.openSettings) private var openSettings

    var body: some Scene {
        MenuBarExtra("Captions", systemImage: model.capturing ? "captions.bubble.fill" : "captions.bubble") {
            StatusLine(store: model.store, capturing: model.capturing)
            Button(model.capturing ? "Stop Captions" : "Start Captions") { model.toggle() }
            Toggle("Microphone", isOn: $model.micOn)
            Toggle("System Audio", isOn: $model.systemOn)
            Divider()
            // SettingsLink doesn't activate an LSUIElement app, so the
            // Settings window opens behind every other window; activate first.
            Button("Settings…") {
                NSApp.activate(ignoringOtherApps: true)
                openSettings()
            }
            Button("Quit") { NSApplication.shared.terminate(nil) }
        }
        Settings {
            SettingsView(settings: model.settings)
        }
    }
}

/// The store's connection state lives on `model.store`, not on `AppModel`
/// itself, so MenuBarExtra's content needs its own `@ObservedObject` on the
/// store to re-render when it changes (e.g. session error) — observing only
/// `model.capturing` here would leave the menu showing stale status text.
/// Status is shown only when capturing or displaying an error; fresh launches
/// hide the default .connecting state since the Mac app doesn't auto-start.
private struct StatusLine: View {
    @ObservedObject var store: CaptionStore
    let capturing: Bool

    var isError: Bool {
        if case .error = store.state {
            return true
        }
        return false
    }

    var body: some View {
        Group {
            if capturing || isError {
                switch store.state {
                case .connecting:
                    Text("Connecting…")
                case .listening:
                    Text("Listening…")
                case .error(let message):
                    Text(message).foregroundStyle(.red)
                }
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }
}

struct SettingsView: View {
    @ObservedObject var settings: SettingsStore

    var body: some View {
        Form {
            Section("Captions") {
                HStack {
                    Slider(value: $settings.fontSize, in: 12...48, step: 1) {
                        Text("Text size")
                    }
                    Text("\(Int(settings.fontSize)) pt")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(width: 40, alignment: .trailing)
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 460)
    }
}
