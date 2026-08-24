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

    var label: String {
        switch self {
        case .recording: return "Recording"
        case .liveOnly: return "Live only, not saved"
        case .onDevice: return "On device, not saved"
        }
    }
}

struct CaptionView: View {
    @ObservedObject var store: CaptionStore
    let indicator: CaptionIndicator
    /// Set from the phone. A default here so previews and any future caller
    /// need not thread it through to say "the usual size".
    var textSize: Double = 16
    /// Absent when there is nothing this screen can stop.
    let onStop: (() -> Void)?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(store.paragraphs.enumerated()), id: \.element.id) { index, paragraph in
                    text(for: paragraph, isLast: index == store.paragraphs.count - 1)
                        .font(.system(size: textSize))
                }
                // Nothing final yet: the partial is all there is to show.
                if store.paragraphs.isEmpty, !store.partial.isEmpty {
                    Text(store.partial).font(.system(size: textSize)).foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
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
                case .recording:
                    Circle().fill(.green)
                case .liveOnly:
                    Circle().strokeBorder(.green, lineWidth: 1.5)
                case .onDevice:
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
