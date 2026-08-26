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

/// Status view Task 4 built: transcribing/waiting, session count. Task 10
/// added the live transcript itself — once the phone has produced any text
/// for the current (or just-ended) session, that replaces the plain status
/// display so the phone reads as a second screen for the conversation the
/// watch is capturing. Only covers captions this phone transcribes itself;
/// see `WCTranscriberService.finalizedLines`.
private struct TranscriberStatusView: View {
    @ObservedObject private var service = WCTranscriberService.shared

    private var hasText: Bool {
        !service.finalizedLines.isEmpty || !service.currentPartial.isEmpty
    }

    var body: some View {
        NavigationStack {
            Group {
                if hasText {
                    LiveTranscriptView(finalizedLines: service.finalizedLines,
                                        currentPartial: service.currentPartial)
                } else {
                    waitingView
                }
            }
            .navigationTitle("Captions")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private var waitingView: some View {
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
    }
}

/// Rolling transcript for the session `WCTranscriberService` is (or just
/// was) producing: committed finals followed by the in-progress line,
/// auto-scrolled to the bottom as text arrives. The in-progress line is
/// secondary-colored so it reads as not-yet-committed, matching the
/// cumulative-partial convention it's rendering (replaced wholesale on every
/// partial, never appended to).
private struct LiveTranscriptView: View {
    let finalizedLines: [String]
    let currentPartial: String

    private static let bottomAnchorId = "bottom"

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(finalizedLines.enumerated()), id: \.offset) { _, line in
                        Text(line)
                            .font(.body)
                    }
                    if !currentPartial.isEmpty {
                        Text(currentPartial)
                            .font(.body)
                            .foregroundStyle(.secondary)
                    }
                    Color.clear
                        .frame(height: 1)
                        .id(Self.bottomAnchorId)
                }
                .padding()
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .onChange(of: finalizedLines.count) { _, _ in
                withAnimation { proxy.scrollTo(Self.bottomAnchorId, anchor: .bottom) }
            }
            .onChange(of: currentPartial) { _, _ in
                proxy.scrollTo(Self.bottomAnchorId, anchor: .bottom)
            }
            .onAppear {
                proxy.scrollTo(Self.bottomAnchorId, anchor: .bottom)
            }
        }
    }
}
