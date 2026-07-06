import Foundation
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

    func toggle() {
        capturing ? stop() : start()
    }

    func start() {
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
        panel.show(store: store)
        Task { await controller.start() }
    }

    func stop() {
        controller?.stop()
        controller = nil
        capturing = false
        panel.hide()
    }
}
