import Foundation
import CaptionCore

/// Asks the relay whether anything is reading the phone's session.
///
/// This is what makes an always-running capture affordable. The microphone
/// stays live so captions start the instant you raise your wrist, but audio
/// only leaves the phone while the Watch is actually watching — so battery,
/// cellular data and per-minute transcription are all paid for the minutes you
/// read rather than the hours the app is running.
///
/// A poll rather than a push, because the phone has no channel the Watch can
/// reach directly, and because presence is a fading fact rather than an event:
/// the Watch stops reading by going away, which nothing announces.
final class PresenceWatcher {
    private let base: URL
    private let token: String
    private let session: URLSession
    private var task: Task<Void, Never>?

    /// How often to ask. Well inside the relay's 10-second presence window, so
    /// streaming starts within a poll of the Watch opening — and one small
    /// request every few seconds is far cheaper than the audio it gates.
    private let interval: Duration = .seconds(3)

    init(base: URL, token: String) {
        self.base = base
        self.token = token
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 10
        self.session = URLSession(configuration: config)
    }

    /// Calls `onChange` whenever the answer flips, and only then.
    func start(onChange: @escaping @Sendable (Bool) -> Void) {
        task?.cancel()
        task = Task { [weak self] in
            var last: Bool?
            while !Task.isCancelled {
                guard let self else { return }
                let reader = await self.fetchPresence()
                if reader != last {
                    last = reader
                    onChange(reader)
                }
                try? await Task.sleep(for: self.interval)
            }
        }
    }

    func stop() {
        task?.cancel()
        task = nil
    }

    /// False on any failure. An unreachable relay is not an audience, and
    /// streaming into one would waste exactly what this exists to save.
    private func fetchPresence() async -> Bool {
        var components = URLComponents(
            url: base.appendingPathComponent("v1/presence"), resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "session", value: PhoneAudio.sessionID),
            URLQueryItem(name: "token", value: token),
        ]
        guard let url = components.url,
              let (data, response) = try? await session.data(from: url),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return false }
        return json["reader"] as? Bool ?? false
    }
}
