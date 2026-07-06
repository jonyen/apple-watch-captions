import SwiftUI

@main
struct MacCaptionsApp: App {
    @StateObject private var model = AppModel()
    @Environment(\.openWindow) private var openWindow

    var body: some Scene {
        MenuBarExtra("Captions", systemImage: model.capturing ? "captions.bubble.fill" : "captions.bubble") {
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
