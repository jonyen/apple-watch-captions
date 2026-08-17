import SwiftUI
import CaptionRelay

/// Where a launch lands when the last session is old enough to be a new sitting.
struct HomeView: View {
    let lastSession: LastSession?
    let onNew: () -> Void
    /// Caption without keeping a transcript.
    let onLive: () -> Void
    let onContinue: () -> Void
    let onBrowse: () -> Void
    let onTakeCall: () -> Void
    /// Read audio playing on the iPhone. Offered only while the phone is
    /// actually broadcasting — there is nothing to read otherwise, and the row
    /// would only lead to a screen explaining its own uselessness.
    let onPhone: () -> Void
    var phoneBroadcasting: Bool = false
    /// Type in the code the iPhone is showing, to merge this watch into that
    /// account.
    let onPair: () -> Void
    /// Which build this is, so a bug report can name one. Injectable for previews.
    var versionLabel: String = AppBuild.versionLabel

    var body: some View {
        List {
            Button(action: onNew) {
                Label("New session", systemImage: "record.circle")
            }
            // Its own row rather than a half-width sibling of "New session":
            // a glyph alone never said "this one is not kept", and the split
            // row left no space for words that would have. The empty circle
            // against the filled one above is the same distinction said twice.
            Button(action: onLive) {
                Label("Off the record", systemImage: "circle")
            }
            .accessibilityHint("Captions on screen only. Nothing is saved.")
            if lastSession != nil {
                Button(action: onContinue) {
                    Label("Resume previous", systemImage: "arrow.clockwise")
                }
            }
            Button(action: onTakeCall) {
                Label("Tune in", systemImage: "antenna.radiowaves.left.and.right")
            }
            if phoneBroadcasting {
                Button(action: onPhone) {
                    Label("iPhone audio", systemImage: "iphone")
                }
            }
            Button(action: onBrowse) {
                Label("Transcripts", systemImage: "list.bullet")
            }
            // A one-time setup step, not something reached often once done —
            // it sits below the things actually used every day.
            Button(action: onPair) {
                Label("Pair with iPhone", systemImage: "link")
            }
            // Sits under the actions as a caption, not another thing to tap.
            Text(versionLabel)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
                .listRowBackground(Color.clear)
                .accessibilityLabel("Version \(versionLabel)")
        }
        .navigationTitle("Captions")
    }
}
