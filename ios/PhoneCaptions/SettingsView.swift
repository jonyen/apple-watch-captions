import SwiftUI

/// Settings for the watch app, edited on the phone because a watch is a poor
/// place to change anything you only change once.
struct SettingsView: View {
    @StateObject private var model = SettingsModel()

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
