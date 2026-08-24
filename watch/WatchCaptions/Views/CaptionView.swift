import SwiftUI
import CaptionCore
import CaptionRelay

/// What the dot in the corner is saying.
enum CaptionIndicator {
    /// A mic session being written down.
    case recording
    /// A mic session keeping nothing.
    case liveOnly
    /// A mic session captioned on the watch itself; nothing is saved.
    case onDevice
    /// Reading a live phone call.
    case call
    /// The call is over, or its captions are.
    case callEnded(CallEndReason)
    /// Reading audio playing on the iPhone.
    case phone

    var label: String {
        switch self {
        case .recording: return "Recording"
        case .liveOnly: return "Live only, not saved"
        case .onDevice: return "On device, not saved"
        case .call: return "Tuned in"
        case .phone: return "Reading iPhone audio"
        case .callEnded(.ended): return "Audio ended"
        case .callEnded(.streamLost): return "Captions stopped"
        }
    }
}

struct CaptionView: View {
    @ObservedObject var store: CaptionStore
    let indicator: CaptionIndicator
    /// Set from the phone. A default here so previews and any future caller
    /// need not thread it through to say "the usual size".
    var textSize: Double = 16
    /// Absent when there is nothing this screen can stop. A mic session and a
    /// call the watch holds both have one — for a held call, Stop closes the
    /// relay's stream, which is what ends the call. The relay's fallback does
    /// not: the phone holds that call, so a Stop button there would claim a
    /// power the watch has no way to exercise.
    let onStop: (() -> Void)?
    /// Present only on a call; nil elsewhere leaves the view exactly as it was.
    var onTalkChanged: ((Bool) -> Void)?
    var isTalking = false

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
        .gesture(
            // The whole caption area is the talk target: it keeps captions
            // full-size on a screen where space is the binding constraint, and
            // scrolling is the Digital Crown so touch is otherwise unused.
            DragGesture(minimumDistance: 0)
                .onChanged { _ in if !isTalking { onTalkChanged?(true) } }
                .onEnded { _ in onTalkChanged?(false) },
            isEnabled: onTalkChanged != nil)
        // SwiftUI does not synthesize DragGesture's .onEnded when this view
        // itself leaves the hierarchy mid-press — which happens on a call
        // when store.state flips to .error and this view is swapped for
        // ErrorView. Without this, the model never hears the release. The
        // authoritative fix is in AppModel.endCall(), which force-closes any
        // open turn unconditionally; this closes the gap immediately, while
        // the call is still live and the user hasn't backed out yet, rather
        // than leaving playback muted until they do.
        .onDisappear { if isTalking { onTalkChanged?(false) } }
        .overlay(alignment: .bottom) {
            if isTalking {
                // A stray press must be visible, not silent.
                Label("Talking", systemImage: "mic.fill")
                    .font(.system(size: 11, weight: .semibold))
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(.red, in: Capsule())
            }
        }
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
                case .call:
                    Circle().fill(.blue)
                case .phone:
                    // Blue like a call — audio arriving from elsewhere — but
                    // hollow like live-only, since nothing is being saved.
                    Circle().strokeBorder(.blue, lineWidth: 1.5)
                case .callEnded:
                    Circle().fill(.secondary)
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
            // needs somewhere to live. On a call the watch holds, this is the
            // hangup; on the fallback there is nothing to hang up and no
            // button. See `onStop`.
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
