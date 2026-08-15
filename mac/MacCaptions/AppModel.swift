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

    private var hub: AudioHub?
    private var controller: SessionController?
    private let panel = CaptionPanelController()
    private var stateObservation: AnyCancellable?

    init() {
        observeStore()
        AppDelegate.onReopen = { [weak self] in self?.showPanel() }
    }

    func toggle() {
        capturing ? stop() : start()
    }

    /// Overlay ▶/⏸ control: pause ends the session (a new one starts on
    /// resume — the recognizer has no idle mode), but the panel stays up.
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
        let hub = AudioHub(capture: DualCapture(
            micEnabled: { [weak self] in self?.micOn ?? false },
            systemEnabled: { [weak self] in self?.systemOn ?? false }))
        self.hub = hub
        let controller = SessionController(
            store: store, relay: LocalSpeechRelay(), audio: hub.makeTap(),
            permission: MacPermissions())
        self.controller = controller
        capturing = true
        Task { await controller.start() }
    }

    func pause() {
        controller?.stop()
        controller = nil
        hub = nil
        capturing = false
    }

    func stop() {
        pause()
        panel.hide()
    }

    /// Reflect the store's truth: an errored session counts as ended, but the
    /// panel stays up so the user actually sees why — it's only dismissed by
    /// an explicit stop().
    private func observeStore() {
        stateObservation = store.$state.sink { [weak self] state in
            guard let self, case .error = state else { return }
            self.capturing = false
            self.controller?.stop()
            self.controller = nil
            self.hub = nil
        }
    }
}
