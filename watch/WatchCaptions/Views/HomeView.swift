import SwiftUI

/// Where a launch lands: three ways to start captioning, and everything else
/// behind "More…".
struct HomeView: View {
    /// Asked at tap time, so the answer reflects when Start is tapped rather
    /// than when the menu appeared: is the previous session fresh enough to
    /// offer resuming?
    let shouldOfferResume: () -> Bool
    /// Start a saved relay session from scratch.
    let onStartNew: () -> Void
    /// Pick the previous session back up.
    let onResume: () -> Void
    /// Caption without keeping a transcript.
    let onLive: () -> Void
    /// Caption on the watch itself — no relay, nothing saved.
    let onOnDevice: () -> Void
    /// Transcripts, pairing: the rows used rarely enough to live one tap away.
    let onMore: () -> Void
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
                    onStartNew()
                }
            } label: {
                Label("Start", systemImage: "record.circle")
            }
            // Its own row rather than a half-width sibling of "Start":
            // a glyph alone never said "this one is not kept", and the split
            // row left no space for words that would have. The empty circle
            // against the filled one above is the same distinction said twice.
            Button(action: onLive) {
                Label("Off the record", systemImage: "circle")
            }
            .accessibilityHint("Captions on screen only. Nothing is saved.")
            Button(action: onOnDevice) {
                Label("On device", systemImage: "cpu")
            }
            .accessibilityHint("Captions computed on the watch. Nothing is saved.")
            Button(action: onMore) {
                Label("More…", systemImage: "ellipsis")
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
            Button("Start new", action: onStartNew)
        }
    }
}
