import SwiftUI
import CaptionCore
import CaptionRelay

/// One stored transcript: its summary, then the captions — read-only, no
/// resume action (there is nothing on this app to resume into; that lives on
/// the watch).
struct TranscriptDetailView: View {
    @ObservedObject var history: HistoryStore
    let name: String

    var body: some View {
        Group {
            switch history.detailState {
            case .idle, .loading:
                ProgressView()
            case .failed(let message):
                VStack(spacing: 6) {
                    Text("Couldn't load").font(.headline)
                    Text(message).font(.subheadline).foregroundStyle(.secondary)
                }
            case .loaded:
                if let detail = history.detail {
                    content(for: detail)
                } else {
                    Text("Nothing here").foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle(history.detail?.title ?? "Transcript")
        .navigationBarTitleDisplayMode(.inline)
        .task { await history.loadDetail(name: name) }
        .refreshable { await history.loadDetail(name: name) }
    }

    private func content(for detail: TranscriptDetail) -> some View {
        let paragraphs = buildParagraphs(from: detail.segments)
        return ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                if let summary = detail.summaryBody {
                    Text(summary.asSummaryMarkdown).font(.body)
                } else {
                    Text("No summary").font(.body).foregroundStyle(.secondary)
                }

                // Guard on paragraphs, not raw segments: empty-text segments
                // are dropped when building paragraphs, so the header must
                // not outlive its rows.
                if !paragraphs.isEmpty {
                    Text("Transcript")
                        .font(.headline)
                        .padding(.top, 8)
                    ForEach(paragraphs) { paragraph in
                        Text(label(for: paragraph)).font(.body)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
        }
    }

    /// Mirrors how the relay labels dual-channel captures.
    private func label(for paragraph: CaptionParagraph) -> String {
        switch paragraph.channel {
        case 0: return "Me: \(paragraph.text)"
        case 1: return "Them: \(paragraph.text)"
        default: return paragraph.text
        }
    }
}
