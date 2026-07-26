import SwiftUI
import CaptionCore

struct CaptionView: View {
    @ObservedObject var store: CaptionStore
    let onStop: () -> Void

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(store.paragraphs.enumerated()), id: \.element.id) { index, paragraph in
                        text(for: paragraph, isLast: index == store.paragraphs.count - 1)
                            .font(.system(size: 16))
                    }
                    // Nothing final yet: the partial is all there is to show.
                    if store.paragraphs.isEmpty, !store.partial.isEmpty {
                        Text(store.partial).font(.system(size: 16)).foregroundStyle(.secondary)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .onChange(of: store.paragraphs.count) { _, _ in scrollToBottom(proxy) }
            .onChange(of: store.paragraphs.last?.text) { _, _ in scrollToBottom(proxy) }
            .onChange(of: store.partial) { _, _ in scrollToBottom(proxy) }
            .overlay(alignment: .topTrailing) {
                Circle().fill(.green).frame(width: 7, height: 7)
            }
            .toolbar {
                // Lowering your wrist no longer ends the session, so ending it
                // needs somewhere to live.
                // Trailing, so it does not take the back chevron's slot.
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

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        proxy.scrollTo("bottom", anchor: .bottom)
    }
}
