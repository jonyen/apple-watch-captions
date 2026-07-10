import Foundation
import Combine
import CaptionCore

/// One running caption engine: its provider, transcript store, and controller.
@MainActor
struct ProviderSession: Identifiable {
    let id = UUID()
    let provider: CaptionProvider
    let store: CaptionStore
    let controller: SessionController
}

@MainActor
final class AppModel: ObservableObject {
    /// Primary transcript store — the menu status line and single-provider
    /// overlay observe this stable instance; the first session always uses it.
    let store = CaptionStore()
    let settings = SettingsStore()
    @Published private(set) var capturing = false
    @Published private(set) var sessions: [ProviderSession] = []
    @Published var micOn = true
    @Published var systemOn = true

    private var hub: AudioHub?
    private let panel = CaptionPanelController()
    private var stateObservations: [AnyCancellable] = []

    init() {
        observeStores()
        AppDelegate.onReopen = { [weak self] in self?.showPanel() }
    }

    func toggle() {
        capturing ? stop() : start()
    }

    /// Overlay ▶/⏸ control: pause ends the sessions (new ones start on
    /// resume — the streaming providers have no idle mode), but the panel stays up.
    func pauseResume() {
        capturing ? pause() : start()
    }

    /// Show the overlay without starting capture (Spotlight/Finder reopen).
    func showPanel() {
        panel.show(model: self)
    }

    func start() {
        guard !capturing else { return }
        panel.show(model: self)

        let providers: [CaptionProvider] = settings.compareProviders
            ? CaptionProvider.allCases
            : [settings.provider]
        let needsRelay = providers.contains { $0.needsRelay }
        var base: URL?
        if needsRelay {
            guard let url = settings.relayURL, settings.configured else {
                store.setError("Set the relay URL and token in Settings.")
                return
            }
            base = url
        }

        let hub = AudioHub(capture: DualCapture(
            micEnabled: { [weak self] in self?.micOn ?? false },
            systemEnabled: { [weak self] in self?.systemOn ?? false }))
        self.hub = hub

        sessions = providers.enumerated().map { index, provider in
            let sessionStore = index == 0 ? store : CaptionStore()
            let relay: Relay = provider.needsRelay
                ? WebSocketRelay(base: base!, token: settings.token, channels: 2, provider: provider)
                : LocalSpeechRelay()
            let controller = SessionController(
                store: sessionStore, relay: relay, audio: hub.makeTap(),
                permission: MacPermissions())
            return ProviderSession(provider: provider, store: sessionStore, controller: controller)
        }
        observeStores()
        capturing = true
        for session in sessions {
            Task { await session.controller.start() }
        }
    }

    func pause() {
        for session in sessions { session.controller.stop() }
        hub = nil
        capturing = false
    }

    func stop() {
        pause()
        panel.hide()
    }

    /// Reflect the stores' truth in the menu/panel: capture counts as ended
    /// only when every session has errored out (in compare mode one failing
    /// provider just shows the error in its own pane). The panel stays up so
    /// the user actually sees why — it's only dismissed by an explicit stop().
    private func observeStores() {
        let stores = sessions.isEmpty ? [store] : sessions.map(\.store)
        stateObservations = stores.map { observed in
            observed.$state.sink { [weak self] state in
                guard let self, case .error = state else { return }
                let allFailed = stores.allSatisfy { candidate in
                    if candidate === observed { return true }  // sink fires before $state updates
                    if case .error = candidate.state { return true }
                    return false
                }
                if allFailed {
                    self.capturing = false
                    for session in self.sessions { session.controller.stop() }
                    self.hub = nil
                }
            }
        }
    }
}
