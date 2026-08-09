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
    @ObservedObject private var callCaptions: CallCaptions
    @ObservedObject private var callVoice: CallVoice

    init(model: AppModel) {
        self.model = model
        store = model.store
        history = model.history
        callCaptions = model.callCaptions
        callVoice = model.callVoice
    }

    var body: some View {
        NavigationStack(path: $model.path) {
                HomeView(
                    lastSession: model.lastSession,
                    onNew: { Task { await model.startNew() } },
                    onLive: { Task { await model.startLive() } },
                    onContinue: { Task { await model.continueLast() } },
                    onBrowse: { Task { await model.showHistory() } },
                    onTakeCall: { model.takeCall() })
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
                    case .call:
                        call
                            // Closing the stream is what ends the call, so
                            // backing out hangs up exactly like tapping End.
                            .onDisappear { Task { await model.leaveCall() } }
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
                indicator: model.live ? .liveOnly : .recording,
                onStop: { model.stop() },
                onTalkChanged: nil)
        case .error(let message):
            ErrorView(message: message, onRetry: { Task { await model.retry() } })
        }
    }

    @ViewBuilder
    private var call: some View {
        switch store.state {
        // A Deepgram failure (e.g. "transcription connection lost") lands here
        // via CallCaptions.poll applying the .error message. Unlike a mic
        // session, there is nothing on the watch to retry — the relay owns the
        // connection to the caller — so this just shows the error rather than
        // offering a Retry that would restart audio capture that never existed.
        case .error(let message):
            ErrorView(message: message, onRetry: nil)
        // Taking a call opens this screen before anyone has dialled, so the
        // wait gets a screen of its own rather than an empty transcript
        // claiming to be a call.
        case _ where model.callWaiting:
            CallWaitingView(onCancel: { Task { await model.endCall() } })
        case .connecting, .listening:
            CaptionView(
                store: store,
                indicator: callCaptions.ended.map(CaptionIndicator.callEnded) ?? .call,
                // Stop only where it can do something: on the fallback the
                // phone holds the call, and nothing here can hang it up.
                onStop: model.callTwoWay ? { Task { await model.endCall() } } : nil,
                // Same for the talk gesture — that stream is one-way, so a
                // turn recorded into it could only end in a refusal.
                onTalkChanged: model.callTwoWay ? { talking in
                    Task {
                        if talking { model.beginTalking() }
                        else { await model.endTalking() }
                    }
                } : nil,
                isTalking: model.callVoice.isTalking)
        }
    }
}
