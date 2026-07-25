import SwiftUI
import CaptionCore

/// One stored transcript: its summary first, then the captions themselves,
/// with an option to pick the conversation back up.
struct TranscriptDetailView: View {
    @ObservedObject var history: HistoryStore
    let onResume: (String) -> Void

    var body: some View {
        Group {
            switch history.detailState {
            case .idle, .loading:
                ProgressView()
            case .failed(let message):
                VStack(spacing: 6) {
                    Text("Couldn't load").font(.headline)
                    Text(message).font(.caption).foregroundStyle(.secondary)
                }
            case .loaded:
                if let detail = history.detail {
                    content(for: detail)
                } else {
                    Text("Nothing here").foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("Transcript")
    }

    private func content(for detail: TranscriptDetail) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                if let title = detail.title {
                    Text(title).font(.system(size: 16, weight: .semibold))
                }

                if let summary = detail.summaryBody {
                    Text(summary).font(.system(size: 14))
                } else {
                    Text("No summary").font(.system(size: 14)).foregroundStyle(.secondary)
                }

                Button { onResume(detail.name) } label: {
                    Label("Continue this session", systemImage: "mic.fill")
                }
                .padding(.vertical, 4)

                if !detail.segments.isEmpty {
                    Text("Transcript")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.secondary)
                    ForEach(detail.segments) { segment in
                        Text(label(for: segment)).font(.system(size: 14))
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// Mirrors how the relay labels dual-channel captures.
    private func label(for segment: TranscriptSegment) -> String {
        switch segment.channel {
        case 0: return "Me: \(segment.text)"
        case 1: return "Them: \(segment.text)"
        default: return segment.text
        }
    }
}
