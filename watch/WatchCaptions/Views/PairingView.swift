import SwiftUI
import CaptionRelay

/// Types in the six-digit code the iPhone is showing, so the relay can merge
/// this watch's account into the phone's. There is no software keyboard fast
/// enough for six digits on a 40 mm screen, so each position gets its own
/// Digital Crown wheel instead of a text field.
struct PairingView: View {
    let client: PairingClient
    /// Called once the relay confirms the merge, after the brief confirmation
    /// on screen has had a moment to be seen. This view has no opinion on
    /// where "back" leads — the caller owns navigation, same as every other
    /// screen here.
    let onPaired: () -> Void

    @State private var digits = [0, 0, 0, 0, 0, 0]
    @State private var phase: Phase = .entering

    private enum Phase: Equatable {
        case entering
        case submitting
        /// A code that didn't work — wrong, expired, or already used. Not a
        /// failure: the most likely fix is to re-read the phone and try
        /// again, so the digits stay editable and the reason stays plain
        /// rather than alarming.
        case rejected(String)
        /// The relay itself couldn't be reached. Unlike `.rejected`, this one
        /// is a genuine failure.
        case failed(String)
        case paired
    }

    var body: some View {
        VStack(spacing: 12) {
            Text("Enter the code shown on your iPhone")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            digitPickers
                .disabled(phase == .submitting || phase == .paired)

            status
        }
        .padding(.horizontal, 4)
        .navigationTitle("Pair")
        .toolbar {
            // Trailing, like Stop on a call — the one action this screen can
            // take, kept out of the back chevron's slot.
            ToolbarItem(placement: .topBarTrailing) {
                if phase == .submitting {
                    ProgressView()
                } else if phase != .paired {
                    Button(action: submit) {
                        Label("Pair", systemImage: "checkmark")
                    }
                }
            }
        }
    }

    private var digitPickers: some View {
        HStack(spacing: 0) {
            ForEach(0..<6, id: \.self) { index in
                Picker("", selection: $digits[index]) {
                    ForEach(0..<10, id: \.self) { value in
                        Text("\(value)").tag(value)
                    }
                }
                .pickerStyle(.wheel)
                .labelsHidden()
                .frame(width: 24)
                .accessibilityLabel("Digit \(index + 1)")
            }
        }
    }

    @ViewBuilder
    private var status: some View {
        switch phase {
        case .entering, .submitting:
            EmptyView()
        case .rejected(let reason):
            Text(reason)
                .font(.footnote)
                .foregroundStyle(.orange)
                .multilineTextAlignment(.center)
        case .failed(let message):
            Text(message)
                .font(.footnote)
                .foregroundStyle(.red)
                .multilineTextAlignment(.center)
        case .paired:
            Label("Paired", systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green)
        }
    }

    private func submit() {
        let code = digits.map(String.init).joined()
        phase = .submitting
        Task {
            do {
                switch try await client.claim(code: code) {
                case .paired:
                    phase = .paired
                    // A beat to actually see the checkmark before the screen
                    // it belongs to is gone.
                    try? await Task.sleep(for: .seconds(1))
                    onPaired()
                case .rejected(let reason):
                    phase = .rejected(reason)
                }
            } catch {
                phase = .failed("Couldn't reach the relay. Check your connection and try again.")
            }
        }
    }
}
