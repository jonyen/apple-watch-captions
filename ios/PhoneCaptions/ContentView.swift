import SwiftUI

/// The phone app's only screen for now: what the on-phone transcriber is
/// doing for the watch. There is nothing to configure here — pairing and
/// settings are gone; the watch just talks to whichever phone it is next to.
///
/// A single view rather than a `TabView`, on purpose: Task 8 adds a
/// transcripts tab later, and that is a small diff onto this, not a rewrite.
struct ContentView: View {
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
