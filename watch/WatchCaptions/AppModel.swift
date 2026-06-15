import Foundation
import CaptionCore

@MainActor
final class AppModel: ObservableObject {
    let store = CaptionStore()
    private let controller: SessionController

    init() {
        let url = Self.tokenizedURL(Secrets.relayURL, token: Secrets.authToken)
        let controller = SessionController(
            store: store,
            relay: RelayClient(url: url),
            audio: AudioCapture(),
            permission: MicPermission()
        )
        self.controller = controller
    }

    func start() async { await controller.start() }
    func stop() { controller.stop() }

    private static func tokenizedURL(_ base: URL, token: String) -> URL {
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "token", value: token)]
        return components.url!
    }
}
