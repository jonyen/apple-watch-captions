import Foundation
import SwiftUI

/// The watch app's settings, edited here and stored on the relay.
///
/// The two apps cannot talk to each other — the watch app is standalone, so
/// there is no paired-companion channel — so the relay holds them and the watch
/// reads them when it launches.
@MainActor
final class SettingsModel: ObservableObject {
    @Published var captionTextSize: Double = 16
    @Published var autoOpenPhoneAudio = true
    @Published var saveTranscripts = true
    @Published var provider = "deepgram"

    @Published private(set) var loading = true
    @Published private(set) var error: String?

    static let providers = ["deepgram", "openai", "assemblyai"]
    static let textSizeRange: ClosedRange<Double> = 12...30

    private let base = Secrets.relayURL
    private let session = URLSession(configuration: .default)
    /// Coalesces edits: dragging the size slider must not post per pixel.
    private var writeTask: Task<Void, Never>?

    func load() async {
        loading = true
        defer { loading = false }
        guard let json = await request(method: "GET", body: nil) else {
            error = "Can't reach the relay"
            return
        }
        error = nil
        apply(json)
    }

    /// Queue a write. Debounced, so a slider drag posts once when it settles.
    func save() {
        writeTask?.cancel()
        writeTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled, let self else { return }
            await self.write()
        }
    }

    private func write() async {
        let body = try? JSONSerialization.data(withJSONObject: [
            "captionTextSize": captionTextSize,
            "autoOpenPhoneAudio": autoOpenPhoneAudio,
            "saveTranscripts": saveTranscripts,
            "provider": provider,
        ])
        guard let json = await request(method: "PUT", body: body) else {
            error = "Couldn't save"
            return
        }
        error = nil
        // Apply what came back rather than what was sent: the relay clamps
        // values, so this is where an out-of-range size visibly becomes the
        // one actually stored.
        apply(json)
    }

    private func apply(_ json: [String: Any]) {
        if let size = json["captionTextSize"] as? Double { captionTextSize = size }
        else if let size = json["captionTextSize"] as? Int { captionTextSize = Double(size) }
        if let auto = json["autoOpenPhoneAudio"] as? Bool { autoOpenPhoneAudio = auto }
        if let save = json["saveTranscripts"] as? Bool { saveTranscripts = save }
        if let name = json["provider"] as? String { provider = name }
    }

    private func request(method: String, body: Data?) async -> [String: Any]? {
        let url = base.appendingPathComponent("v1/settings")
        guard let bearer = try? await DeviceIdentity.shared.token() else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        if body != nil {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        guard let (data, response) = try? await session.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200
        else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }
}
