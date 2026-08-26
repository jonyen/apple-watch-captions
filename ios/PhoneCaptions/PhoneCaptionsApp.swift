import SwiftUI

@main
struct PhoneCaptionsApp: App {
    init() {
        WCTranscriberService.shared.activate()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
