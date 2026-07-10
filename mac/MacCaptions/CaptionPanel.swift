import SwiftUI
import CaptionCore

/// Floating, non-activating, always-on-top translucent caption panel.
@MainActor
final class CaptionPanelController {
    private var panel: NSPanel?
    private var savedFrame: NSRect?

    func show(model: AppModel) {
        if panel != nil { return }
        let view = NSHostingView(rootView: CaptionPanelView(
            model: model,
            store: model.store,
            settings: model.settings,
            onDoubleTap: { [weak self] in self?.toggleZoom() }))
        let p = NSPanel(
            contentRect: NSRect(x: 0, y: 120, width: 560, height: 140),
            styleMask: [.nonactivatingPanel, .titled, .fullSizeContentView, .resizable],
            backing: .buffered, defer: false)
        p.level = .floating
        p.titleVisibility = .hidden
        p.titlebarAppearsTransparent = true
        p.isMovableByWindowBackground = true
        p.backgroundColor = .clear
        p.isOpaque = false
        p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        p.hidesOnDeactivate = false
        // The overlay's own controls are the affordances; the system
        // traffic lights don't belong on a floating caption panel.
        for b: NSWindow.ButtonType in [.closeButton, .miniaturizeButton, .zoomButton] {
            p.standardWindowButton(b)?.isHidden = true
        }
        p.contentView = view
        p.center()
        p.orderFrontRegardless()
        panel = p
    }

    func hide() {
        panel?.orderOut(nil)
        panel = nil
        savedFrame = nil
    }

    /// Double-click: grow the panel to fill the screen's visible area;
    /// double-click again to restore the previous frame.
    private func toggleZoom() {
        guard let p = panel, let screen = p.screen ?? NSScreen.main else { return }
        if let saved = savedFrame {
            p.setFrame(saved, display: true, animate: true)
            savedFrame = nil
        } else {
            savedFrame = p.frame
            p.setFrame(screen.visibleFrame, display: true, animate: true)
        }
    }
}

struct CaptionPanelView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var store: CaptionStore
    @ObservedObject var settings: SettingsStore
    let onDoubleTap: () -> Void
    @State private var hovering = false

    var body: some View {
        Group {
            if model.sessions.count > 1 {
                // Compare mode: one pane per provider, equal heights.
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(model.sessions) { session in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(session.provider.displayName)
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(.tertiary)
                            CaptionFlow(store: session.store, fontSize: settings.fontSize)
                                .frame(maxWidth: .infinity, maxHeight: .infinity,
                                       alignment: .bottomLeading)
                        }
                        .frame(maxHeight: .infinity)
                    }
                }
            } else {
                CaptionFlow(store: store, fontSize: settings.fontSize)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
            }
        }
        .padding(14)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
        .contentShape(RoundedRectangle(cornerRadius: 14))
        .onTapGesture(count: 2) { onDoubleTap() }
        .overlay(alignment: .topTrailing) {
            HStack(spacing: 10) {
                Button { model.pauseResume() } label: {
                    Image(systemName: model.capturing ? "pause.circle.fill" : "play.circle.fill")
                        .font(.system(size: 16))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .help(model.capturing ? "Pause captions" : "Start captions")
                Button { model.stop() } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 16))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .help("Stop captions and close")
            }
            .padding(8)
            // Keep controls discoverable while idle; fade them out mid-caption.
            .opacity(hovering || !model.capturing ? 1 : 0)
        }
        .onHover { hovering = $0 }
        .padding(8)
    }
}

/// One provider's transcript as flowing text: all finals from the session and
/// the gray in-progress partial share a single wrapping Text, so lines re-wrap
/// whenever the panel is resized. The scroll view stays pinned to the newest
/// caption until the user scrolls up to read history.
private struct CaptionFlow: View {
    @ObservedObject var store: CaptionStore
    let fontSize: Double

    private var finals: String {
        store.lines.map(\.text).joined(separator: " ")
    }
    private var partial: String {
        store.partials.sorted { $0.key < $1.key }
            .map(\.value)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 4) {
                if case .error(let message) = store.state {
                    Text(message)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(.red)
                        .lineLimit(2)
                }
                if !finals.isEmpty || !partial.isEmpty {
                    (Text(finals + (finals.isEmpty || partial.isEmpty ? "" : " "))
                        + Text(partial).foregroundColor(.secondary))
                        .font(.system(size: fontSize, weight: .medium))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .defaultScrollAnchor(.bottom)
    }
}
