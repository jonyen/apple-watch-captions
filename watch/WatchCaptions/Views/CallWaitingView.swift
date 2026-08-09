import SwiftUI

/// The call screen before anyone has dialled.
///
/// Taking a call is a *wait*: the screen is opened by choice, and polling it
/// is what tells the relay the watch is here to receive one. Without a state
/// of its own that wait rendered as a blank caption view whose indicator read
/// "Captioning a call" — claiming a conversation that did not exist — and the
/// talk gesture was live throughout, recording into a turn the relay could
/// only refuse.
struct CallWaitingView: View {
    /// Hangs up the wait. The same action as Stop on a live call, because the
    /// relay side is the same: stop claiming presence, so a call arriving now
    /// rings out to the phone rather than to a screen nobody is watching.
    let onCancel: () -> Void

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "phone.badge.waveform")
                .font(.system(size: 22))
                .foregroundStyle(.blue)
                .symbolEffect(.pulse)
            Text("Waiting for a call…")
                .font(.system(size: 15))
            Text("Keep this screen open")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal, 4)
        // One accessibility element: read as a single sentence rather than as
        // three fragments and an unlabelled glyph.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Waiting for a call. Keep this screen open.")
        .toolbar {
            // Trailing, so it does not take the back chevron's slot — the same
            // placement Stop gets on a live call, since it is the same choice.
            ToolbarItem(placement: .topBarTrailing) {
                Button(action: onCancel) {
                    Label("Stop waiting", systemImage: "stop.fill")
                }
            }
        }
    }
}
