import Foundation

/// Whether a finished transcript has reached Notion, and where it landed.
public struct ExportStatus: Equatable, Sendable {
    public let exported: Bool
    /// Whether this transcript can ever be exported. The relay skips ones with
    /// almost no content, and a session that produced no captions leaves no
    /// transcript at all; either way there is nothing to wait for.
    public let eligible: Bool
    public let url: String?
    /// Topic from the summary; absent when the session was never summarized.
    public let title: String?

    public init(exported: Bool, eligible: Bool = true, url: String?, title: String?) {
        self.exported = exported
        self.eligible = eligible
        self.url = url
        self.title = title
    }

    /// No such transcript on the relay — nothing will ever arrive for it.
    public static let unavailable = ExportStatus(
        exported: false, eligible: false, url: nil, title: nil)
}

/// Asks the relay whether a transcript has been exported yet.
public protocol ExportStatusClient: Sendable {
    func exportStatus(name: String) async throws -> ExportStatus
}

/// A transcript that made it to Notion — what the notification is about.
public struct ExportedTranscript: Equatable, Sendable {
    public let name: String
    public let title: String?
    public let url: String?

    public init(name: String, title: String?, url: String?) {
        self.name = name
        self.title = title
        self.url = url
    }
}

/// A transcript whose export the app is still waiting on.
public struct PendingExport: Equatable, Sendable {
    public let name: String
    /// When the session ended, which is when the wait's clock starts.
    public let endedAt: Date

    public init(name: String, endedAt: Date) {
        self.name = name
        self.endedAt = endedAt
    }
}

public enum ExportPollResult: Equatable, Sendable {
    /// Nothing is being waited on.
    case idle
    /// Reached Notion. No longer tracked — this is reported once.
    case exported(ExportedTranscript)
    /// Not there yet, and worth asking again.
    case waiting
    /// The wait ran out of time. No longer tracked.
    case gaveUp
}

/// Waits for a finished transcript to reach Notion and reports when it does.
///
/// Nothing is exported at the moment you tap Stop: the relay closes the
/// session, generates a summary, and only then writes the Notion page, which
/// takes seconds to tens of seconds. So the wait outlives the screen — and
/// often the app, since watchOS suspends a watch app shortly after the wrist
/// drops and may terminate it outright. The transcript being waited on is
/// therefore persisted, and any later wake — a background refresh, or simply
/// opening the app again — can pick the wait back up and finish it.
@MainActor
public final class ExportWatcher {
    /// How long to keep waiting before giving up. Generous on purpose: a relay
    /// that has just booted works through its export backlog first, and a
    /// notification an hour late is worse than none.
    public static let window: TimeInterval = 15 * 60

    /// Gap between polls while the app is on screen.
    public static let pollInterval: TimeInterval = 3

    private let client: ExportStatusClient
    private let defaults: UserDefaults
    private let now: () -> Date

    /// The transcript being waited on, if any. Survives relaunches.
    public private(set) var pending: PendingExport?

    public init(client: ExportStatusClient,
                defaults: UserDefaults = .standard,
                now: @escaping () -> Date = Date.init) {
        self.client = client
        self.defaults = defaults
        self.now = now
        pending = Self.load(from: defaults)
    }

    /// Start waiting on `name`, replacing any wait already in progress — the
    /// session that just ended is the one worth a notification.
    public func track(name: String) {
        let entry = PendingExport(name: name, endedAt: now())
        pending = entry
        defaults.set(entry.name, forKey: Keys.name)
        defaults.set(entry.endedAt.timeIntervalSince1970, forKey: Keys.endedAt)
    }

    /// Stop waiting, here and across relaunches.
    public func forget() {
        pending = nil
        defaults.removeObject(forKey: Keys.name)
        defaults.removeObject(forKey: Keys.endedAt)
    }

    /// Ask the relay once. A failed request counts as `.waiting`: a watch out
    /// of range is not evidence the export failed.
    public func poll() async -> ExportPollResult {
        guard let pending else { return .idle }
        guard now().timeIntervalSince(pending.endedAt) <= Self.window else {
            forget()
            return .gaveUp
        }
        guard let status = try? await client.exportStatus(name: pending.name)
        else { return .waiting }   // a watch out of range is not an answer
        guard status.eligible else {
            // The relay has decided this one is never going to Notion. Waiting
            // out the window would only burn background wakes to say nothing.
            forget()
            return .gaveUp
        }
        guard status.exported else { return .waiting }

        // Another `track` may have landed while this request was in flight;
        // resolving the newer wait with this older answer would drop it.
        guard self.pending?.name == pending.name else { return .waiting }
        forget()
        return .exported(ExportedTranscript(
            name: pending.name, title: status.title, url: status.url))
    }

    private enum Keys {
        static let name = "pendingExportName"
        static let endedAt = "pendingExportEndedAt"
    }

    private static func load(from defaults: UserDefaults) -> PendingExport? {
        guard let name = defaults.string(forKey: Keys.name) else { return nil }
        let endedAt = defaults.double(forKey: Keys.endedAt)
        guard endedAt > 0 else { return nil }
        return PendingExport(name: name, endedAt: Date(timeIntervalSince1970: endedAt))
    }
}

/// Decode `GET /v1/transcripts/<name>/export`. Anything that does not clearly
/// say "exported, and here is the page" reads as not exported — a relay too old
/// to know the endpoint answers something else entirely, and treating that as
/// success would announce a page that does not exist.
public func decodeExportStatus(_ json: [String: Any]) -> ExportStatus {
    // Absent means eligible: a relay too old to send the field is one whose
    // transcripts might still export, so keep waiting rather than give up.
    let eligible = json["eligible"] as? Bool ?? true
    guard json["exported"] as? Bool == true, let url = json["url"] as? String, !url.isEmpty
    else { return ExportStatus(exported: false, eligible: eligible, url: nil, title: nil) }
    return ExportStatus(
        exported: true, eligible: true, url: url, title: json["title"] as? String)
}
