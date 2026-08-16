import Foundation

/// Settings the phone writes and this watch reads.
///
/// They live on the relay because the two apps cannot talk to each other: the
/// watch app is standalone, so there is no paired-companion channel between it
/// and the phone. Shared here rather than in the app so the decoding is
/// unit-tested against the relay's real response shape, like every other
/// response this project decodes.
public struct Settings: Equatable, Sendable {
    /// Caption font size, in points.
    public var captionTextSize: Double
    /// Open iPhone audio on launch when the phone is broadcasting.
    public var autoOpenPhoneAudio: Bool
    /// Whether a new mic session is written down or kept live-only.
    public var saveTranscripts: Bool

    public init(captionTextSize: Double = 16,
                autoOpenPhoneAudio: Bool = true,
                saveTranscripts: Bool = true) {
        self.captionTextSize = captionTextSize
        self.autoOpenPhoneAudio = autoOpenPhoneAudio
        self.saveTranscripts = saveTranscripts
    }

    public static let defaults = Settings()
}

/// Decodes the relay's settings response.
///
/// Every field falls back to its default independently. A relay that predates a
/// setting, or one a version ahead sending a field this build has never heard
/// of, should leave the watch working rather than reverting everything at once.
public func decodeSettings(_ json: [String: Any]) -> Settings {
    var settings = Settings.defaults
    if let size = json["captionTextSize"] as? Double {
        settings.captionTextSize = size
    } else if let size = json["captionTextSize"] as? Int {
        settings.captionTextSize = Double(size)
    }
    if let auto = json["autoOpenPhoneAudio"] as? Bool {
        settings.autoOpenPhoneAudio = auto
    }
    if let save = json["saveTranscripts"] as? Bool {
        settings.saveTranscripts = save
    }
    return settings
}

/// Whether anything is producing or reading a session, from `GET /v1/presence`.
public struct Presence: Equatable, Sendable {
    public var reader: Bool
    public var producer: Bool

    public init(reader: Bool = false, producer: Bool = false) {
        self.reader = reader
        self.producer = producer
    }
}

public func decodePresence(_ json: [String: Any]) -> Presence {
    Presence(reader: json["reader"] as? Bool ?? false,
             producer: json["producer"] as? Bool ?? false)
}
