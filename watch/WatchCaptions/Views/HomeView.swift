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
    /// Read audio playing on the iPhone. Offered only while the phone is
    /// actually broadcasting — there is nothing to read otherwise, and the row
    /// would only lead to a screen explaining its own uselessness.
    let onPhone: () -> Void
    var phoneBroadcasting: Bool = false
    /// Which build this is, so a bug report can name one. Injectable for previews.
    var versionLabel: String = AppBuild.versionLabel

    var body: some View {
        List {
            // One row, two halves split by a divider: the wide one records,
            // the narrow one does not. The row itself is an ordinary list
            // row, so the system supplies the fill, insets, height and
            // corner radius that make it a sibling of "Transcripts" below.
            // The halves are nested plain buttons purely so each stays
            // independently tappable inside that one row.
            HStack(spacing: 0) {
                Button(action: onNew) {
                    // A `Label` scales its icon and text as one unit, and on
                    // the 40mm case that unit never shrinks enough before
                    // hitting the truncating edge — the words lose out to the
                    // dot. Composing the pieces by hand lets the scale floor
                    // apply to the text alone; the glyph stays full size.
                    HStack(spacing: 4) {
                        Image(systemName: "record.circle")
                        Text("New session")
                            .lineLimit(1)
                            .minimumScaleFactor(0.6)
                    }
                    // Keeps the glyph off the row's leading edge. Modest on
                    // purpose: this content already competes with that scale
                    // floor for space on the 40mm case, the tightest there is.
                    .padding(.horizontal, 10)
                    .frame(maxWidth: .infinity)
                    // Without this only the glyph and letters take the tap,
                    // not the empty width between them and the divider.
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                Divider()
                Button(action: onLive) {
                    Image(systemName: "waveform")
                        .frame(width: 40)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Live caption")
                .accessibilityHint("Captions on screen only. Nothing is saved.")
            }
            if lastSession != nil {
                Button(action: onContinue) {
                    Label("Continue last", systemImage: "arrow.clockwise")
                }
            }
            if phoneBroadcasting {
                Button(action: onPhone) {
                    Label("iPhone audio", systemImage: "iphone")
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
