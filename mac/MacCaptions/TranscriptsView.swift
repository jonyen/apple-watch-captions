import SwiftUI

struct TranscriptsView: View {
    let api: RelayAPI?
    @State private var transcripts: [TranscriptSummary] = []
    @State private var selected: TranscriptDetail?
    @State private var error: String?

    var body: some View {
        NavigationSplitView {
            List(transcripts, selection: Binding(
                get: { selected?.name },
                set: { name in
                    guard let name, let api else { return }
                    Task {
                        do {
                            selected = try await api.detail(name: name)
                            error = nil
                        } catch {
                            self.error = "\(error)"
                        }
                    }
                }
            )) { t in
                VStack(alignment: .leading) {
                    Text(formatted(t.startedAt)).font(.headline)
                    Text("\(t.segmentCount) captions\(t.hasSummary ? " · summary" : "")")
                        .font(.caption).foregroundStyle(.secondary)
                    Text(t.preview).lineLimit(1).font(.caption).foregroundStyle(.secondary)
                }
                .tag(t.name)
            }
            .navigationTitle("Transcripts")
        } detail: {
            if let d = selected {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        if let summary = d.summary {
                            Text("Summary").font(.title3.bold())
                            Text(summary).textSelection(.enabled)
                            Divider()
                        }
                        Text("Transcript").font(.title3.bold())
                        ForEach(d.segments) { s in
                            Text(s.text).textSelection(.enabled)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
                }
            } else if let error {
                Text(error).foregroundStyle(.red)
            } else {
                Text("Select a transcript")
            }
        }
        .task { await refresh() }
        .toolbar { Button("Refresh") { Task { await refresh() } } }
    }

    private func refresh() async {
        guard let api else {
            error = "Set the relay URL and token in Settings."
            return
        }
        do {
            transcripts = try await api.list()
            error = nil
        } catch {
            self.error = "\(error)"
        }
    }

    private func formatted(_ iso: String) -> String {
        guard let date = ISO8601DateFormatter().date(from: iso) else { return iso }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
}
