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
        let paragraphs = buildParagraphs(from: detail.segments)
        return ScrollView {
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

                // Guard on paragraphs, not raw segments: empty-text segments are
                // dropped when building paragraphs, so the header must not outlive its rows.
                if !paragraphs.isEmpty {
                    Text("Transcript")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.secondary)
                    ForEach(paragraphs) { paragraph in
                        Text(label(for: paragraph)).font(.system(size: 14))
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// Mirrors how the relay labels dual-channel captures. A change of channel
    /// always starts a new paragraph, so one label per paragraph is right.
    private func label(for paragraph: CaptionParagraph) -> String {
        switch paragraph.channel {
        case 0: return "Me: \(paragraph.text)"
        case 1: return "Them: \(paragraph.text)"
        default: return paragraph.text
        }
    }
}
