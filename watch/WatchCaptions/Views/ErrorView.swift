import SwiftUI

struct ErrorView: View {
    let message: String
    /// Absent when there is nothing to retry — e.g. a call, where the relay
    /// owns the connection and there is no mic session on the watch to restart.
    let onRetry: (() -> Void)?

    var body: some View {
        VStack(spacing: 10) {
            Text(message)
                .font(.footnote)
                .multilineTextAlignment(.center)
                .foregroundStyle(.red)
            if let onRetry {
                Button("Try Again", action: onRetry)
            }
        }
        .padding()
    }
}
