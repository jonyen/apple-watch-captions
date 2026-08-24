import SwiftUI

/// Everything the menu does not need every day: browsing past transcripts,
/// and the one-time pairing step.
struct MoreView: View {
    /// Browse the transcripts past sessions kept.
    let onBrowse: () -> Void
    /// Type in the code the iPhone is showing, to merge this watch into that
    /// account.
    let onPair: () -> Void

    var body: some View {
        List {
            Button(action: onBrowse) {
                Label("Transcripts", systemImage: "list.bullet")
            }
            Button(action: onPair) {
                Label("Pair with iPhone", systemImage: "link")
            }
        }
        .navigationTitle("More")
    }
}
