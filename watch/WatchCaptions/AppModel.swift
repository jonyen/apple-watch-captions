import Foundation
import CaptionCore

@MainActor
final class AppModel: ObservableObject {
    let store = CaptionStore()
    private let controller: SessionController

    init() {
        let base = Self.httpBase(from: Secrets.relayURL)
        controller = SessionController(
            store: store,
            relay: HTTPRelayClient(base: base, token: Secrets.authToken),
            audio: AudioCapture(),
            permission: MicPermission()
        )
    }

    func start() async { await controller.start() }
    func stop() { controller.stop() }

    /// Derive the HTTPS origin (e.g. https://host) from the configured relay URL.
    private static func httpBase(from relayURL: URL) -> URL {
        var components = URLComponents(url: relayURL, resolvingAgainstBaseURL: false)!
        components.scheme = "https"
        components.path = ""
        components.query = nil
        return components.url!
    }
}
