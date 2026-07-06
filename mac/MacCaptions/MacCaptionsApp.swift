import SwiftUI

@main
struct MacCaptionsApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        MenuBarExtra("Captions", systemImage: model.capturing ? "captions.bubble.fill" : "captions.bubble") {
            Button(model.capturing ? "Stop Captions" : "Start Captions") {
                model.toggle()
            }
            Divider()
            Button("Quit") { NSApplication.shared.terminate(nil) }
        }
    }
}
