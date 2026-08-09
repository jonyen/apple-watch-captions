import Combine
import Foundation

/// Sends your voice to the relay.
public protocol CallVoiceClient: Sendable {
    func send(_ pcm: Data) async throws
}

/// Push-to-talk: collects microphone audio only while the control is held, and
/// sends it as one turn when released.
///
/// The mic keeps running throughout — starting and stopping capture per turn
/// would clip the first word — so anything captured outside a turn is dropped
/// here rather than transmitted. That is also what keeps the room off the call.
@MainActor
public final class CallVoice: ObservableObject {
    @Published public private(set) var isTalking = false

    private let client: CallVoiceClient
    private var turn = Data()

    public init(client: CallVoiceClient) {
        self.client = client
    }

    public func beginTalking() {
        turn = Data()
        isTalking = true
    }

    /// Offer captured audio. Kept only while a turn is open.
    public func capture(_ pcm: Data) {
        guard isTalking else { return }
        turn.append(pcm)
    }

    /// Close the turn and send it. Releasing always stops the talking state,
    /// even when the send fails — otherwise the UI claims you are still
    /// speaking into a call that never heard you.
    ///
    /// `turn` and `isTalking` are both read and reset before the `await`
    /// below, not after, so a `beginTalking()` that arrives while `send` is
    /// still in flight starts the next turn cleanly rather than clobbering or
    /// being clobbered by this one: `outgoing` already holds its own copy of
    /// the data to send, and nothing after the `await` writes back into
    /// `turn` or `isTalking`. Unlike `CallCaptions.generation` or
    /// `CallAudio.inFlight`, there is no stale state left to guard against.
    public func endTalking() async {
        guard isTalking else { return }
        isTalking = false
        let outgoing = turn
        turn = Data()
        guard !outgoing.isEmpty else { return }
        try? await client.send(outgoing)
    }
}
