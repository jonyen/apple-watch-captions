import SwiftUI
import CaptionRelay

/// The code a watch types in to move its account into this phone's. Shown
/// large — this is read aloud, or copied by hand onto a screen with no
/// keyboard fast enough for it — with a countdown to the ten-minute expiry,
/// since a stale code left on screen just wastes someone's time typing a
/// code that will only be refused.
struct PairingView: View {
    let client: PairingClient

    @State private var phase: Phase = .issuing

    private enum Phase {
        case issuing
        case active(PairingCode)
        case failed(String)
    }

    var body: some View {
        VStack(spacing: 24) {
            switch phase {
            case .issuing:
                issuing
            case .active(let code):
                // A `TimelineView` rather than a one-shot check: the code is
                // shown for minutes at a time, and this is what turns "ten
                // minutes from now" into a countdown that actually counts,
                // and what notices the moment it lapses without any timer
                // bookkeeping of our own.
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    if context.date < code.expiresAt {
                        activeCode(code, now: context.date)
                    } else {
                        expiredCode
                    }
                }
            case .failed(let message):
                failure(message)
            }
        }
        .padding()
        .navigationTitle("Pair a Watch")
        .navigationBarTitleDisplayMode(.inline)
        .task { await issue() }
    }

    private var issuing: some View {
        VStack(spacing: 8) {
            ProgressView()
            Text("Getting a code…").foregroundStyle(.secondary)
        }
    }

    private func activeCode(_ code: PairingCode, now: Date) -> some View {
        VStack(spacing: 16) {
            Text("Enter this on your watch")
                .font(.subheadline)
                .foregroundStyle(.secondary)

            // Large and grouped, so it reads at arm's length and holds
            // together in memory on the walk from this screen to the watch.
            Text(grouped(code.code))
                .font(.system(size: 52, weight: .bold, design: .rounded))
                .monospacedDigit()
                .minimumScaleFactor(0.5)
                .lineLimit(1)
                .accessibilityLabel("Pairing code \(spelledOut(code.code))")

            Text(countdown(until: code.expiresAt, from: now))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .monospacedDigit()
        }
    }

    private var expiredCode: some View {
        VStack(spacing: 12) {
            Text("This code expired")
                .font(.headline)
            Text("Codes only last ten minutes. Get a new one to keep pairing.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("Get a new code") { Task { await issue() } }
                .buttonStyle(.borderedProminent)
        }
    }

    private func failure(_ message: String) -> some View {
        VStack(spacing: 12) {
            Text(message)
                .multilineTextAlignment(.center)
                .foregroundStyle(.red)
            Button("Try Again") { Task { await issue() } }
                .buttonStyle(.bordered)
        }
    }

    private func issue() async {
        phase = .issuing
        do {
            phase = .active(try await client.issueCode())
        } catch {
            phase = .failed("Couldn't reach the relay. Check your connection and try again.")
        }
    }

    /// "483920" → "483 920": a pause partway through is easier to hold in
    /// your head while turning to type it into the other hand's watch.
    private func grouped(_ code: String) -> String {
        guard code.count == 6 else { return code }
        let mid = code.index(code.startIndex, offsetBy: 3)
        return "\(code[..<mid]) \(code[mid...])"
    }

    /// VoiceOver reads a bare digit run as a single large number ("four
    /// hundred eighty-three thousand…"); spelling it out digit by digit is
    /// what the sighted reader gets from the grouped text for free.
    private func spelledOut(_ code: String) -> String {
        code.map(String.init).joined(separator: " ")
    }

    private func countdown(until expiresAt: Date, from now: Date) -> String {
        let remaining = max(0, Int(expiresAt.timeIntervalSince(now)))
        return String(format: "Expires in %d:%02d", remaining / 60, remaining % 60)
    }
}
