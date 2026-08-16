import SwiftUI
import CaptionCore
import CaptionRelay

/// Past transcripts, newest first. The topic reads first; the date only
/// disambiguates, so it sits underneath in smaller type.
struct HistoryListView: View {
    @ObservedObject var history: HistoryStore
    let onSelect: (String) -> Void

    var body: some View {
        Group {
            switch history.listState {
            case .idle, .loading:
                ProgressView()
            case .failed(let message):
                VStack(spacing: 6) {
                    Text("Couldn't load").font(.headline)
                    Text(message).font(.caption).foregroundStyle(.secondary)
                }
            case .loaded where history.items.isEmpty:
                Text("No transcripts yet").foregroundStyle(.secondary)
            case .loaded:
                List(history.items) { item in
                    Button { onSelect(item.name) } label: {
                        row(for: item)
                    }
                    // No full swipe: the gesture always ends on a deliberate
                    // tap of the trash, since there is no undo on the watch.
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button(role: .destructive) {
                            Task { await history.delete(item) }
                        } label: {
                            Label("Delete", systemImage: "trash")
                        }
                    }
                }
            }
        }
        .navigationTitle("Transcripts")
        .alert("Couldn't delete", isPresented: deleteFailed) {
            Button("OK") { history.clearDeleteError() }
        } message: {
            Text(history.deleteError ?? "")
        }
    }

    private var deleteFailed: Binding<Bool> {
        Binding(get: { history.deleteError != nil },
                set: { if !$0 { history.clearDeleteError() } })
    }

    private func row(for item: TranscriptListItem) -> some View {
        let row = TranscriptRow(item: item)
        return VStack(alignment: .leading, spacing: 2) {
            Text(row.primary)
                .font(.system(size: 15, weight: .medium))
                .lineLimit(2)
            if let secondary = row.secondary {
                Text(secondary)
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
