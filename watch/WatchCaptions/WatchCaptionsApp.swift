import SwiftUI
import CaptionCore
import CaptionRelay

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
        // A transcript reaches Notion a while after the session ends, by which
        // point the app is usually suspended. This is the wake that lets the
        // notification arrive anyway.
        .backgroundTask(.appRefresh) { _ in
            await model.checkPendingExport()
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
                    shouldOfferResume: { model.shouldOfferResume },
                    onStart: { Task { await model.start() } },
                    onResume: { Task { await model.continueLast() } },
                    mode: $model.mode,
                    keepTranscripts: $model.keepTranscripts,
                    onBrowse: { Task { await model.showHistory() } },
                    onPair: { model.showPairing() })
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
                    case .pairing:
                        PairingView(client: model.pairingClient) {
                            // Pop back to the menu, the same "done" as Stop.
                            model.path = []
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
            CaptionView(
                store: store,
                // On-device shows "not saved" until the uploader's first line
                // lands on the relay — honest about a keep the relay may
                // never see — and relay sessions keep their old pair.
                indicator: model.onDevice
                    ? (model.onDeviceKept ? .onDeviceSaved : .onDevice)
                    : (model.live ? .liveOnly : .recording),
                textSize: model.settings.captionTextSize,
                onStop: { model.stop() })
        case .error(let message):
            ErrorView(message: message, onRetry: { Task { await model.retry() } })
        }
    }
}
