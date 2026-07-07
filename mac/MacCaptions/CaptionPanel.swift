import SwiftUI
import CaptionCore

/// Floating, non-activating, always-on-top translucent caption panel.
@MainActor
final class CaptionPanelController {
    private var panel: NSPanel?

    private var savedFrame: NSRect?

    func show(store: CaptionStore, onClose: @escaping () -> Void) {
        if panel != nil { return }
        let view = NSHostingView(rootView: CaptionPanelView(
            store: store,
            onClose: onClose,
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
        // The overlay's own hover X is the close affordance; the system
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
    @ObservedObject var store: CaptionStore
    let onClose: () -> Void
    let onDoubleTap: () -> Void
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if case .error(let message) = store.state {
                Text(message)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.red)
                    .lineLimit(2)
            }
            ForEach(store.lines.suffix(3)) { line in
                Text(line.text)
                    .font(.system(size: 18, weight: .medium))
            }
            ForEach(store.partials.sorted(by: { $0.key < $1.key }), id: \.key) { channel, text in
                if !text.isEmpty {
                    Text(text)
                        .font(.system(size: 18, weight: .medium))
                        .foregroundStyle(.secondary)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
        .padding(14)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
        .contentShape(RoundedRectangle(cornerRadius: 14))
        .onTapGesture(count: 2) { onDoubleTap() }
        .overlay(alignment: .topTrailing) {
            Button(action: onClose) {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 16))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .padding(8)
            .opacity(hovering ? 1 : 0)
            .help("Stop captions and close")
        }
        .onHover { hovering = $0 }
        .padding(8)
    }
}
