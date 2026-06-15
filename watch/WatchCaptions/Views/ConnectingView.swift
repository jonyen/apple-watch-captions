import SwiftUI

struct ConnectingView: View {
    var body: some View {
        VStack(spacing: 8) {
            ProgressView()
            Text("Connecting…").foregroundStyle(.secondary)
        }
    }
}
