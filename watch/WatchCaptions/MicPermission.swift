import Foundation
import AVFoundation
import CaptionCore

struct MicPermission: MicPermissionProviding {
    func ensureGranted() async -> Bool {
        await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { granted in
                continuation.resume(returning: granted)
            }
        }
    }
}
