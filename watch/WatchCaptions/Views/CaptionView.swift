import SwiftUI
import CaptionCore

struct CaptionView: View {
    @ObservedObject var store: CaptionStore

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(store.lines.enumerated()), id: \.offset) { _, line in
                        Text(line).font(.system(size: 16))
                    }
                    if !store.partial.isEmpty {
                        Text(store.partial).font(.system(size: 16)).foregroundStyle(.secondary)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .onChange(of: store.lines.count) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
            .onChange(of: store.partial) { _, _ in proxy.scrollTo("bottom", anchor: .bottom) }
            .overlay(alignment: .topTrailing) {
                Circle().fill(.green).frame(width: 7, height: 7)
            }
        }
    }
}
