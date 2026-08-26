import SwiftUI
import CaptionCore

/// What the dot in the corner is saying.
enum CaptionIndicator {
    /// A mic session being written down.
    case recording
    /// A mic session keeping nothing.
    case liveOnly
    /// A mic session captioned on the watch itself; nothing is saved.
    case onDevice
    /// Captioned on the watch, with each line forwarded to the relay's
    /// transcript — on-device compute, saved all the same.
    case onDeviceSaved

    var label: String {
        switch self {
        case .recording: return "Recording"
        case .liveOnly: return "Live only, not saved"
        case .onDevice: return "On device, not saved"
        case .onDeviceSaved: return "On device"
        }
    }
}

struct CaptionView: View {
    @ObservedObject var store: CaptionStore
    let indicator: CaptionIndicator
    /// The base caption size before the double-tap multiplier below. No
    /// caller sets this to anything but the default today — the watch no
    /// longer syncs settings from the phone — but it stays a parameter
    /// rather than a constant so a future per-session override has somewhere
    /// to land.
    var textSize: Double = 16
    /// Absent when there is nothing this screen can stop.
    let onStop: (() -> Void)?

    /// Double-tapping the captions cycles small, medium, large, entirely
    /// local to the watch, persisted so the choice holds across sessions.
    /// The crown is not an option for this — it already scrolls the
    /// transcript.
    @AppStorage("captionSizeStep") private var sizeStep = 0
    private static let sizeMultipliers: [Double] = [1.0, 1.35, 1.75]
    private var effectiveSize: Double {
        textSize * Self.sizeMultipliers[min(max(sizeStep, 0), Self.sizeMultipliers.count - 1)]
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(store.paragraphs.enumerated()), id: \.element.id) { index, paragraph in
                    text(for: paragraph, isLast: index == store.paragraphs.count - 1)
                        .font(.system(size: effectiveSize))
                }
                // Nothing final yet: the partial is all there is to show.
                if store.paragraphs.isEmpty, !store.partial.isEmpty {
                    Text(store.partial).font(.system(size: effectiveSize)).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            // On the whole content column, not the ScrollView: a gesture on
            // the scroll container would swallow the drags that scroll.
            .contentShape(Rectangle())
            .onTapGesture(count: 2) {
                sizeStep = (sizeStep + 1) % Self.sizeMultipliers.count
            }
        }
        // Stay with the newest caption as text arrives, but let a scroll up
        // stick. Driving this by scrolling to a sentinel on every change fought
        // the user instead: partials land about once a second, so each attempt
        // to read back was yanked to the bottom within a second — and a resumed
        // session's restored transcript, which arrives above the live captions,
        // was scrolled past the moment it landed and could not be reached.
        .defaultScrollAnchor(.bottom)
        // Filled means this is being recorded; a hollow ring means the captions
        // are all there is. Same spot and size either way — there is no room on
        // this screen for a second piece of chrome.
        .overlay(alignment: .topTrailing) {
            Group {
                switch indicator {
                case .recording, .onDeviceSaved:
                    Circle().fill(.green)
                case .liveOnly, .onDevice:
                    Circle().strokeBorder(.green, lineWidth: 1.5)
                }
            }
            .frame(width: 7, height: 7)
            // A bare shape is not an accessibility element, so VoiceOver would
            // skip the indicator entirely and a label alone would do nothing.
            .accessibilityElement()
            .accessibilityLabel(indicator.label)
        }
        .toolbar {
            // Lowering your wrist no longer ends the session, so ending it
            // needs somewhere to live.
            // Trailing, so it does not take the back chevron's slot.
            if let onStop {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(action: onStop) {
                        Label("Stop", systemImage: "stop.fill")
                    }
                }
            }
        }
    }

    /// The in-progress partial continues the paragraph it belongs to rather than
    /// taking a line of its own — otherwise every utterance still breaks.
    private func text(for paragraph: CaptionParagraph, isLast: Bool) -> Text {
        guard isLast, !store.partial.isEmpty else { return Text(paragraph.text) }
        return Text(paragraph.text) + Text(" " + store.partial).foregroundStyle(.secondary)
    }
}
