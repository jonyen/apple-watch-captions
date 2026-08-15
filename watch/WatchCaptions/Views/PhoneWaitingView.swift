import SwiftUI

/// Shown when iPhone audio is open but the phone is not broadcasting.
///
/// The alternative is the connecting spinner, which is indistinguishable from a
/// slow relay and says nothing about the one thing that would fix it. The phone
/// has to be told to start, every time — no API can start a broadcast — so the
/// screen that waits is the right place to say so.
///
/// It replaces itself as soon as audio arrives; there is nothing to dismiss.
struct PhoneWaitingView: View {
    var body: some View {
        ScrollView {
            VStack(spacing: 10) {
                Image(systemName: "iphone.gen3.slash")
                    .font(.title2)
                    .foregroundStyle(.secondary)

                Text("Not broadcasting")
                    .font(.headline)

                // Named in the order they are tapped, because this is read at a
                // glance while holding a phone in the other hand.
                VStack(alignment: .leading, spacing: 6) {
                    step(1, "Open Watch Captions Relay on your iPhone")
                    step(2, "Tap Start Broadcast")
                }
                .font(.footnote)
                .frame(maxWidth: .infinity, alignment: .leading)

                Text("Captions appear here on their own.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .multilineTextAlignment(.leading)
            .padding(.horizontal, 4)
        }
        .navigationTitle("iPhone audio")
    }

    private func step(_ number: Int, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Text("\(number).")
                .foregroundStyle(.secondary)
                .monospacedDigit()
            Text(text)
        }
    }
}

#Preview {
    PhoneWaitingView()
}
