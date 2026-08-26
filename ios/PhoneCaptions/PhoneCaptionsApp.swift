import SwiftUI

@main
struct PhoneCaptionsApp: App {
    @Environment(\.scenePhase) private var scenePhase
    /// Store-and-forward delivery of kept sessions (Task 6). Lives for the
    /// app's whole lifetime, subscribed to `WCTranscriberService` once here.
    private let forwardingStore = ForwardingStore()

    init() {
        WCTranscriberService.shared.activate()
        forwardingStore.start(service: WCTranscriberService.shared)
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .active {
                forwardingStore.foregrounded()
            }
        }
    }
}
