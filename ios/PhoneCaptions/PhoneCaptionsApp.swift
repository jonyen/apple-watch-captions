import SwiftUI

@main
struct PhoneCaptionsApp: App {
    init() {
        SpikeWC.runIfRequested()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
