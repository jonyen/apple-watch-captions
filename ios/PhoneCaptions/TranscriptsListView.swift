import SwiftUI
import CaptionRelay

/// Read-only, newest-first list of the watch's kept transcripts. There is
/// nothing to authenticate the relay call with until the watch has shared
/// its identity at least once (`PhoneWire.shareIdentity`, stored in
/// `WatchIdentityStore`), so before that this shows an explanatory empty
/// state instead of attempting — and failing — a request.
struct TranscriptsListView: View {
    @StateObject private var history = HistoryStore(client: TranscriptsListView.makeClient())
    /// Re-checked on appear (rather than observed live) so returning to this
    /// tab after a watch session picks up a link that landed while the tab
    /// was in the background; a watch sharing identity while this screen is
    /// already the frontmost view still just needs the same pull-to-refresh
    /// everything else here uses.
    @State private var linked = WatchIdentityStore.read() != nil

    var body: some View {
        NavigationStack {
            Group {
                if linked {
                    listContent
                } else {
                    unlinkedState
                }
            }
            .navigationTitle("Transcripts")
        }
        .onAppear { linked = WatchIdentityStore.read() != nil }
    }

    private var listContent: some View {
        Group {
            switch history.listState {
            case .idle, .loading:
                ProgressView()
            case .failed(let message):
                VStack(spacing: 6) {
                    Text("Couldn't load").font(.headline)
                    Text(message).font(.subheadline).foregroundStyle(.secondary)
                }
            case .loaded where history.items.isEmpty:
                Text("No transcripts yet").foregroundStyle(.secondary)
            case .loaded:
                List(history.items) { item in
                    NavigationLink {
                        TranscriptDetailView(history: history, name: item.name)
                    } label: {
                        row(for: item)
                    }
                }
                .listStyle(.plain)
            }
        }
        .refreshable { await history.load() }
        .task { await history.load() }
    }

    private var unlinkedState: some View {
        VStack(spacing: 12) {
            Image(systemName: "applewatch.slash")
                .font(.system(size: 40))
                .foregroundStyle(.secondary)
            Text("Not linked yet")
                .font(.headline)
            Text("Run captions once on your Apple Watch near this phone to link it. Come back here afterward and pull to refresh.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
        }
    }

    private func row(for item: TranscriptListItem) -> some View {
        let row = TranscriptRow(item: item)
        return VStack(alignment: .leading, spacing: 2) {
            Text(row.primary).font(.body)
            if let secondary = row.secondary {
                Text(secondary).font(.subheadline).foregroundStyle(.secondary)
            }
        }
    }

    private static func makeClient() -> RelayHistoryClient {
        RelayHistoryClient(base: Secrets.relayURL, token: {
            guard let token = WatchIdentityStore.read() else {
                throw HistoryError.message("Not linked to a watch yet")
            }
            return token
        })
    }
}
