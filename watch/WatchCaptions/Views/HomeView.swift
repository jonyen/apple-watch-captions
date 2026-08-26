import SwiftUI

/// Where a launch lands: Start, the "Keep transcripts" toggle that shapes
/// what Start does, the transcript list, and the one-time pairing step.
///
/// There is no mode to choose: the watch always tries to caption instantly
/// on-device and refine with the best remote transcriber it can reach — the
/// iPhone over `WatchConnectivity`, else the iMac relay — and falls back to
/// on-device alone only when neither is reachable (see `AppModel.start()`).
struct HomeView: View {
    /// Asked at tap time, so the answer reflects when Start is tapped rather
    /// than when the menu appeared: is the previous session fresh enough to
    /// offer resuming?
    let shouldOfferResume: () -> Bool
    /// Start a session in whatever shape the toggle and reachability ask.
    /// Also the dialog's "Start new": the dialog only appears in the
    /// kept-relay shape, where starting fresh is exactly what this does.
    let onStart: () -> Void
    /// Pick the previous session back up.
    let onResume: () -> Void
    /// Keep a transcript of each session.
    @Binding var keepTranscripts: Bool
    /// Browse the transcripts past sessions kept.
    let onBrowse: () -> Void
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
            Toggle(isOn: $keepTranscripts) {
                Label("Keep transcripts", systemImage: "doc.text")
            }
            .accessibilityHint("Save a transcript of each session. Off means nothing is kept.")
            Button(action: onBrowse) {
                Label("Transcripts", systemImage: "list.bullet")
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
