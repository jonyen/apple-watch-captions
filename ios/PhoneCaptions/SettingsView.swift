import SwiftUI
import CaptionRelay
import CaptionRelayLive

/// Settings for the watch app, edited on the phone because a watch is a poor
/// place to change anything you only change once.
struct SettingsView: View {
    @StateObject private var model = SettingsModel()
    /// Task 5's relay-backed conformance to `PairingClient`, built the same
    /// way every other relay client here is: a fixed origin plus a token
    /// provider that resolves through `DeviceIdentity`. A plain `let` rather
    /// than something `@State`-held — like the other clients in this app, it
    /// is a stateless value type, so rebuilding it costs nothing.
    private let pairingClient: PairingClient = RelayPairingClient(
        base: Secrets.relayURL,
        token: { try await DeviceIdentity.shared.token() }
    )

    var body: some View {
        NavigationStack {
            form
        }
    }

    private var form: some View {
        Form {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("Caption text size")
                        Spacer()
                        Text("\(Int(model.captionTextSize)) pt")
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                    }
                    Slider(
                        value: $model.captionTextSize,
                        in: SettingsModel.textSizeRange,
                        step: 1
                    ) { editing in
                        if !editing { model.save() }
                    }
                    // Shown at the chosen size, so the choice is legible before
                    // walking away from the phone and finding out on a 40 mm
                    // screen.
                    Text("The quick brown fox jumps over the lazy dog")
                        .font(.system(size: model.captionTextSize))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            } header: {
                Text("On the watch")
            }

            Section {
                Toggle("Open iPhone audio automatically", isOn: $model.autoOpenPhoneAudio)
                    .onChange(of: model.autoOpenPhoneAudio) { model.save() }
                Toggle("Save transcripts", isOn: $model.saveTranscripts)
                    .onChange(of: model.saveTranscripts) { model.save() }
            } footer: {
                Text("With transcripts off, sessions are captioned on screen and kept nowhere — nothing saved, summarized, or exported.")
            }

            Section {
                Picker("Speech provider", selection: $model.provider) {
                    ForEach(SettingsModel.providers, id: \.self) { name in
                        Text(name.capitalized).tag(name)
                    }
                }
                .onChange(of: model.provider) { model.save() }
            } footer: {
                Text("Applies to the next session. Existing sessions keep the provider they started with.")
            }

            Section {
                NavigationLink {
                    PairingView(client: pairingClient)
                } label: {
                    Label("Pair a Watch", systemImage: "link")
                }
            } footer: {
                Text("Shows a code your watch can type in, which moves its transcripts into this account.")
            }

            if let error = model.error {
                Section {
                    Text(error).foregroundStyle(.red)
                }
            }
        }
        .navigationTitle("Watch Settings")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if model.loading { ProgressView() }
            }
        }
        .task { await model.load() }
    }
}
