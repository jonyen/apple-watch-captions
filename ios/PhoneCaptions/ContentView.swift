import SwiftUI
import ReplayKit

/// Two pages, swiped between: the thing you do, and the things you set.
///
/// Settings are a page rather than a pushed screen because they are a sibling
/// of the broadcast control, not a detail of it — and because a swipe is one
/// gesture where a push and a back tap are two.
struct ContentView: View {
    var body: some View {
        TabView {
            BroadcastView()
            SettingsView()
        }
        .tabViewStyle(.page)
        // Always visible, so the second page is discoverable rather than
        // something you find by accident.
        .indexViewStyle(.page(backgroundDisplayMode: .always))
    }
}

private struct BroadcastView: View {
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
                    Text("Start the broadcast, then play anything. What the phone plays is captioned on your Watch — raise your wrist and it opens itself.")
                    Text("Audio is only sent while the Watch is reading. The broadcast ends when the phone locks.")
                        .foregroundStyle(.secondary)
                }
                .font(.footnote)

                Spacer()
            }
            .padding()
            .navigationTitle("Watch Captions Relay")
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
