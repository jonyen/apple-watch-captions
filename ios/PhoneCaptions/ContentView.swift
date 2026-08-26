import SwiftUI

/// The app's two tabs: what the on-phone transcriber is doing for the watch,
/// and the watch's own past transcripts once it has linked with this phone.
/// There is nothing to configure here — pairing and settings are gone; the
/// watch just talks to whichever phone it is next to.
struct ContentView: View {
    var body: some View {
        TabView {
            TranscriberStatusView()
                .tabItem { Label("Transcriber", systemImage: "waveform") }
            TranscriptsListView()
                .tabItem { Label("Transcripts", systemImage: "list.bullet") }
        }
    }
}

/// Status view Task 4 built: transcribing/waiting, session count. Unchanged
/// except for the rename off `ContentView`, which now names the tab
/// container instead.
private struct TranscriberStatusView: View {
    @ObservedObject private var service = WCTranscriberService.shared

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                Spacer()

                Image(systemName: service.status == .transcribing
                      ? "waveform"
                      : "applewatch.radiowaves.left.and.right")
                    .font(.system(size: 48))
                    .foregroundStyle(service.status == .transcribing ? .green : .secondary)
                    .symbolEffect(.variableColor.iterative, isActive: service.status == .transcribing)

                Text(service.status == .transcribing ? "Transcribing" : "Waiting for your watch")
                    .font(.title2)

                Text("Sessions served: \(service.sessionsServed)")
                    .font(.footnote)
                    .foregroundStyle(.secondary)

                Spacer()
            }
            .padding()
            .navigationTitle("Captions")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}
