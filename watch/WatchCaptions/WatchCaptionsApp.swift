import SwiftUI
import CaptionCore

@main
struct WatchCaptionsApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView(model: model)
                .task { await model.launch() }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            // Lowering your wrist backgrounds the app but must not end the
            // session — the audio background mode keeps the mic live, so
            // capture simply continues. Only Stop ends a session.
            case .active: Task { await model.launch() }
            case .background, .inactive: break
            @unknown default: break
            }
        }
    }
}

private struct RootView: View {
    @ObservedObject var model: AppModel
    @ObservedObject private var store: CaptionStore
    @ObservedObject private var history: HistoryStore

    init(model: AppModel) {
        self.model = model
        store = model.store
        history = model.history
    }

    var body: some View {
        NavigationStack(path: $model.path) {
                HomeView(
                    lastSession: model.lastSession,
                    onNew: { Task { await model.startNew() } },
                    onLive: { Task { await model.startLive() } },
                    onContinue: { Task { await model.continueLast() } },
                    onBrowse: { Task { await model.showHistory() } })
                .navigationDestination(for: AppModel.Route.self) { route in
                    switch route {
                    case .captions:
                        captions
                            // Backing out pauses; the session stays resumable.
                            .onDisappear { model.leaveCaptions() }
                    case .history:
                        HistoryListView(history: history) { name in
                            Task { await model.showDetail(name: name) }
                        }
                    case .detail:
                        TranscriptDetailView(history: history) { name in
                            Task { await model.resume(name: name) }
                        }
                    }
                }
        }
    }

    @ViewBuilder
    private var captions: some View {
        switch store.state {
        case .connecting:
            ConnectingView()
        case .listening:
            CaptionView(store: store, isLive: model.live, onStop: { model.stop() })
        case .error(let message):
            ErrorView(message: message, onRetry: { Task { await model.retry() } })
        }
    }
}
