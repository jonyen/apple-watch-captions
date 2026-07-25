import SwiftUI
import CaptionCore

/// Where a launch lands when the last session is old enough to be a new sitting.
struct HomeView: View {
    let lastSession: LastSession?
    let onNew: () -> Void
    let onContinue: () -> Void
    let onBrowse: () -> Void

    var body: some View {
        List {
            Button(action: onNew) {
                Label("New session", systemImage: "mic.fill")
            }
            if lastSession != nil {
                Button(action: onContinue) {
                    Label("Continue last", systemImage: "arrow.clockwise")
                }
            }
            Button(action: onBrowse) {
                Label("Transcripts", systemImage: "list.bullet")
            }
        }
        .navigationTitle("Captions")
    }
}
