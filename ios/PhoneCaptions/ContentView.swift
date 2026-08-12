import SwiftUI

struct ContentView: View {
    @StateObject private var model = CaptionRelayModel()

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 24) {
                status

                Toggle("Listening", isOn: Binding(
                    get: { model.capturing },
                    set: { on in
                        Task { on ? await model.startCapturing() : model.stopCapturing() }
                    }))
                .font(.headline)

                Text("Leave this on. The microphone stays live so captions start the moment you open iPhone audio on your Watch — but nothing is sent anywhere until the Watch is actually reading.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)

                if model.micDenied {
                    Text("Microphone access is off. Enable it in Settings › Privacy › Microphone.")
                        .font(.footnote)
                        .foregroundStyle(.red)
                }

                Spacer()
            }
            .padding()
            .navigationTitle("Phone Captions")
            .navigationBarTitleDisplayMode(.inline)
        }
        // Starts on launch, so the app is useful without being opened again.
        .task { await model.startCapturing() }
    }

    /// Three states worth telling apart: off, listening but unwatched, and
    /// actually sending. The middle one is the normal resting state, and
    /// looking idle is the point — it means nothing is being spent.
    private var status: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(model.streaming ? .green : (model.capturing ? .secondary : .clear))
                .strokeBorder(model.capturing ? .clear : .secondary, lineWidth: 1.5)
                .frame(width: 12, height: 12)
            Text(label)
                .font(.title3)
        }
    }

    private var label: String {
        if !model.capturing { return "Off" }
        return model.streaming ? "Streaming to your Watch" : "Listening, nothing sent"
    }
}
