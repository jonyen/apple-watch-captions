import SwiftUI
import CaptionCore

/// Where a launch lands when the last session is old enough to be a new sitting.
struct HomeView: View {
    let lastSession: LastSession?
    let onNew: () -> Void
    /// Caption without keeping a transcript.
    let onLive: () -> Void
    let onContinue: () -> Void
    let onBrowse: () -> Void
    /// Which build this is, so a bug report can name one. Injectable for previews.
    var versionLabel: String = AppBuild.versionLabel

    var body: some View {
        List {
            // One row, two buttons: the wide one records, the narrow one does
            // not. `.bordered` on both is load-bearing — a bare Button in a
            // watchOS list row expands to the full width, and two of them
            // would fight over it.
            HStack(spacing: 6) {
                Button(action: onNew) {
                    Label("New session", systemImage: "record.circle")
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .frame(maxWidth: .infinity)
                }
                Button(action: onLive) {
                    Image(systemName: "waveform")
                }
                .frame(width: 40)
                .accessibilityLabel("Live caption")
                .accessibilityHint("Captions on screen only. Nothing is saved.")
            }
            .buttonStyle(.bordered)
            if lastSession != nil {
                Button(action: onContinue) {
                    Label("Continue last", systemImage: "arrow.clockwise")
                }
            }
            Button(action: onBrowse) {
                Label("Transcripts", systemImage: "list.bullet")
            }
            // Sits under the actions as a caption, not as a fourth thing to tap.
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
