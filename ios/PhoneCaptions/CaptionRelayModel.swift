import Foundation
import AVFoundation
import SwiftUI

/// Keeps the microphone running and streams it only while the Watch is reading.
///
/// The whole point of the app: nothing to press when you want captions. The mic
/// runs from launch; opening iPhone audio on the Watch is what starts the audio
/// actually going anywhere, and closing that screen stops it again within a few
/// seconds.
@MainActor
final class CaptionRelayModel: ObservableObject {
    /// Whether the mic is running at all. The one switch worth exposing —
    /// leaving a microphone live is a decision, not a default to hide.
    @Published private(set) var capturing = false
    /// Whether audio is currently going to the relay, i.e. the Watch is reading.
    @Published private(set) var streaming = false
    @Published private(set) var micDenied = false

    private let capture = MicCapture()
    private let uploader = RelayUploader(base: Secrets.relayURL, token: Secrets.authToken)
    private let presence = PresenceWatcher(base: Secrets.relayURL, token: Secrets.authToken)

    func startCapturing() async {
        guard !capturing else { return }
        guard await requestMic() else {
            micDenied = true
            return
        }
        micDenied = false
        do {
            // The uploader drops everything while it is stopped, so chunks
            // captured with no audience go nowhere. Keeping the engine running
            // through those stretches is what makes captions start immediately
            // rather than after an audio session negotiation.
            try capture.start { [weak self] data in
                self?.uploader.send(data)
            }
        } catch {
            UploadLog.append("mic start failed: \(error.localizedDescription)")
            return
        }
        capturing = true
        presence.start { [weak self] reader in
            Task { @MainActor in self?.setStreaming(reader) }
        }
    }

    func stopCapturing() {
        guard capturing else { return }
        presence.stop()
        setStreaming(false)
        capture.stop()
        capturing = false
    }

    private func setStreaming(_ on: Bool) {
        guard on != streaming else { return }
        streaming = on
        if on {
            UploadLog.append("reader present — streaming")
            uploader.start()
        } else {
            UploadLog.append("no reader — idle")
            uploader.stop()
        }
    }

    private func requestMic() async -> Bool {
        await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { granted in
                continuation.resume(returning: granted)
            }
        }
    }
}
