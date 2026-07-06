import SwiftUI
import CaptionCore

/// Floating, non-activating, always-on-top translucent caption panel.
@MainActor
final class CaptionPanelController {
    private var panel: NSPanel?

    func show(store: CaptionStore) {
        if panel != nil { return }
        let view = NSHostingView(rootView: CaptionPanelView(store: store))
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
        p.contentView = view
        p.center()
        p.orderFrontRegardless()
        panel = p
    }

    func hide() {
        panel?.orderOut(nil)
        panel = nil
    }
}

struct CaptionPanelView: View {
    @ObservedObject var store: CaptionStore

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if case .error(let message) = store.state {
                Text(message)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.red)
                    .lineLimit(2)
            }
            ForEach(store.lines.suffix(3)) { line in
                Text(label(line.channel) + line.text)
                    .font(.system(size: 18, weight: .medium))
            }
            ForEach(store.partials.sorted(by: { $0.key < $1.key }), id: \.key) { channel, text in
                if !text.isEmpty {
                    Text(label(channel) + text)
                        .font(.system(size: 18, weight: .medium))
                        .foregroundStyle(.secondary)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
        .padding(14)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
        .padding(8)
    }

    private func label(_ channel: Int?) -> String {
        switch channel {
        case 0: return "Me: "
        case 1: return "Them: "
        default: return ""
        }
    }
}
