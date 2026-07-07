import Foundation
import Combine
import CaptionCore

@MainActor
final class AppModel: ObservableObject {
    let store = CaptionStore()
    let settings = SettingsStore()
    @Published private(set) var capturing = false
    @Published var micOn = true
    @Published var systemOn = true

    private var controller: SessionController?
    private let panel = CaptionPanelController()
    private var stateObservation: AnyCancellable?

    init() {
        // Reflect the store's truth in the menu/panel: an error ends the
        // active-capture state (menu stops saying "Stop Captions", icon
        // reverts), but the panel stays up so the user actually sees why —
        // it's only dismissed by an explicit stop().
        stateObservation = store.$state.sink { [weak self] state in
            guard let self else { return }
            if case .error = state {
                self.capturing = false
                self.controller = nil
            }
        }
        AppDelegate.onReopen = { [weak self] in self?.showPanel() }
    }

    func toggle() {
        capturing ? stop() : start()
    }

    /// Overlay ▶/⏸ control: pause ends the relay session (a new one starts on
    /// resume — Deepgram has no idle mode), but the panel stays up.
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
        guard let base = settings.relayURL, settings.configured else {
            store.setError("Set the relay URL and token in Settings.")
            return
        }
        let relay = WebSocketRelay(base: base, token: settings.token, channels: 2)
        let capture = DualCapture(
            micEnabled: { [weak self] in self?.micOn ?? false },
            systemEnabled: { [weak self] in self?.systemOn ?? false })
        let controller = SessionController(
            store: store, relay: relay, audio: capture, permission: MacPermissions())
        self.controller = controller
        capturing = true
        Task { await controller.start() }
    }

    func pause() {
        controller?.stop()
        controller = nil
        capturing = false
    }

    func stop() {
        pause()
        panel.hide()
    }
}
