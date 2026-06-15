import SwiftUI
import CaptionCore

@main
struct WatchCaptionsApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView(store: model.store) { Task { await model.start() } }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active: Task { await model.start() }
            case .background: model.stop()
            case .inactive: break
            @unknown default: break
            }
        }
    }
}

private struct RootView: View {
    @ObservedObject var store: CaptionStore
    let onRetry: () -> Void

    var body: some View {
        switch store.state {
        case .connecting: ConnectingView()
        case .listening: CaptionView(store: store)
        case .error(let message): ErrorView(message: message, onRetry: onRetry)
        }
    }
}
