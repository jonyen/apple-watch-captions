import SwiftUI
import ReplayKit

struct ContentView: View {
    private let picker = BroadcastPicker()

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 20) {
                Button {
                    picker.present()
                } label: {
                    Label("Start / Stop Broadcast", systemImage: "dot.radiowaves.left.and.right")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)

                VStack(alignment: .leading, spacing: 12) {
                    Text("While the broadcast is running, whatever is playing on this phone is captioned on your Watch — open iPhone audio there.")
                    Text("The broadcast ends when the phone locks.")
                        .foregroundStyle(.secondary)
                }
                .font(.footnote)

                Spacer()
            }
            .padding()
            .navigationTitle("Phone Captions")
            .navigationBarTitleDisplayMode(.inline)
            // The picker has to be in the hierarchy to present its sheet, but
            // its own control is drawn by the system and is easy to miss, so it
            // is parked here at zero size and driven by the button above.
            .background(picker.frame(width: 0, height: 0))
        }
    }
}

/// Wraps `RPSystemBroadcastPickerView` and taps its internal button on demand.
///
/// There is no API to start a broadcast programmatically, and none to present
/// the picker's sheet either — the only trigger is a touch on the `UIButton` the
/// view builds for itself. Reaching in for that button is what lets the sheet
/// have a control you can actually see and place.
private struct BroadcastPicker: UIViewRepresentable {
    private let view: RPSystemBroadcastPickerView = {
        let picker = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 60, height: 60))
        picker.preferredExtension = "com.jonyen.phonecaptions.upload"
        picker.showsMicrophoneButton = false
        return picker
    }()

    func present() {
        for subview in view.subviews {
            if let button = subview as? UIButton {
                button.sendActions(for: .touchUpInside)
                return
            }
        }
    }

    func makeUIView(context: Context) -> RPSystemBroadcastPickerView { view }

    func updateUIView(_ uiView: RPSystemBroadcastPickerView, context: Context) {}
}
