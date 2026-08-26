import SwiftUI

/// Where a launch lands: Start, the two toggles that shape what Start does,
/// the transcript list, and the one-time pairing step.
struct HomeView: View {
    /// Asked at tap time, so the answer reflects when Start is tapped rather
    /// than when the menu appeared: is the previous session fresh enough to
    /// offer resuming?
    let shouldOfferResume: () -> Bool
    /// Start a session in whatever shape the toggles ask. Also the dialog's
    /// "Start new": the dialog only appears in the kept-relay shape, where
    /// starting fresh is exactly what this does.
    let onStart: () -> Void
    /// Pick the previous session back up.
    let onResume: () -> Void
    /// Compute captions on the watch itself instead of streaming to the relay.
    @Binding var onDevice: Bool
    /// Keep a transcript of each session.
    @Binding var keepTranscripts: Bool
    /// Browse the transcripts past sessions kept.
    let onBrowse: () -> Void
    /// Type in the code the iPhone is showing, to merge this watch into that
    /// account.
    let onPair: () -> Void
    /// Which build this is, so a bug report can name one. Injectable for previews.
    var versionLabel: String = AppBuild.versionLabel

    /// True while Start is asking whether to resume the previous session.
    @State private var confirmingResume = false

    var body: some View {
        List {
            Button {
                // A session that ended moments ago is probably the same
                // conversation — but silently resuming read as the app
                // ignoring the tap, so it asks.
                if shouldOfferResume() {
                    confirmingResume = true
                } else {
                    onStart()
                }
            } label: {
                Label("Start", systemImage: "record.circle")
            }
            // Toggles rather than more ways to start: what a session is —
            // where it is computed, whether it is kept — is a setting that
            // outlives any one tap, and Start stays the only verb.
            // Off is the default and means hybrid: instant on-watch captions
            // refined by the iMac when it is reachable. On means the watch
            // alone, nothing sent anywhere — the exception, so it gets the
            // label.
            Toggle(isOn: $onDevice) {
                Label("Watch only", systemImage: "cpu")
            }
            .accessibilityHint("Caption entirely on the watch. Nothing is sent to the relay.")
            Toggle(isOn: $keepTranscripts) {
                Label("Keep transcripts", systemImage: "doc.text")
            }
            .accessibilityHint("Save a transcript of each session. Off means nothing is kept.")
            Button(action: onBrowse) {
                Label("Transcripts", systemImage: "list.bullet")
            }
            // A one-time setup step; it sits last for a reason.
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
        .confirmationDialog(
            "Continue the previous session?",
            isPresented: $confirmingResume,
            titleVisibility: .visible
        ) {
            Button("Resume previous", action: onResume)
            Button("Start new", action: onStart)
        }
    }
}
