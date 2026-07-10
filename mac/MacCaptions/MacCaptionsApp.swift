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
    @Environment(\.openWindow) private var openWindow
    @Environment(\.openSettings) private var openSettings

    var body: some Scene {
        MenuBarExtra("Captions", systemImage: model.capturing ? "captions.bubble.fill" : "captions.bubble") {
            StatusLine(store: model.store, capturing: model.capturing)
            Button(model.capturing ? "Stop Captions" : "Start Captions") { model.toggle() }
            Toggle("Microphone", isOn: $model.micOn)
            Toggle("System Audio", isOn: $model.systemOn)
            Divider()
            Button("Usage…") {
                NSApp.activate(ignoringOtherApps: true)
                openWindow(id: "usage")
            }
            Button("Transcripts…") {
                NSApp.activate(ignoringOtherApps: true)
                openWindow(id: "transcripts")
            }
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
        Window("Transcripts", id: "transcripts") {
            TranscriptsView(api: model.settings.configured
                ? RelayAPI(base: model.settings.relayURL!, token: model.settings.token)
                : nil)
        }
        .defaultSize(width: 720, height: 480)
        Window("Usage", id: "usage") {
            UsageView(api: model.settings.configured
                ? RelayAPI(base: model.settings.relayURL!, token: model.settings.token)
                : nil)
        }
        .defaultSize(width: 420, height: 360)
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
            Section("Relay") {
                TextField("Relay URL", text: $settings.relayURLString,
                          prompt: Text("https://watch-captions-relay.fly.dev"))
                SecureField("Auth token", text: $settings.token)
            }
            Section("Captions") {
                Picker("Provider", selection: $settings.provider) {
                    ForEach(CaptionProvider.allCases) { provider in
                        Text(provider.displayName).tag(provider)
                    }
                }
                .disabled(settings.compareProviders)
                Toggle("Compare all providers", isOn: $settings.compareProviders)
                Text("Runs every provider at once with a caption pane per provider. Cloud providers need their API key configured on the relay.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
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
