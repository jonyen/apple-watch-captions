import SwiftUI
import CaptionCore

@main
struct MacCaptionsApp: App {
    @StateObject private var model = AppModel()
    @Environment(\.openWindow) private var openWindow

    var body: some Scene {
        MenuBarExtra("Captions", systemImage: model.capturing ? "captions.bubble.fill" : "captions.bubble") {
            StatusLine(store: model.store)
            Button(model.capturing ? "Stop Captions" : "Start Captions") { model.toggle() }
            Toggle("Microphone", isOn: $model.micOn)
            Toggle("System Audio", isOn: $model.systemOn)
            Divider()
            Button("Transcripts…") { openWindow(id: "transcripts") }
            SettingsLink { Text("Settings…") }
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
    }
}

/// The store's connection state lives on `model.store`, not on `AppModel`
/// itself, so MenuBarExtra's content needs its own `@ObservedObject` on the
/// store to re-render when it changes (e.g. session error) — observing only
/// `model.capturing` here would leave the menu showing stale status text.
private struct StatusLine: View {
    @ObservedObject var store: CaptionStore

    var body: some View {
        Group {
            switch store.state {
            case .connecting:
                Text("Connecting…")
            case .listening:
                Text("Listening…")
            case .error(let message):
                Text(message).foregroundStyle(.red)
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
            TextField("Relay URL", text: $settings.relayURLString,
                      prompt: Text("https://watch-captions-relay.fly.dev"))
            SecureField("Auth token", text: $settings.token)
        }
        .padding()
        .frame(width: 420)
    }
}
