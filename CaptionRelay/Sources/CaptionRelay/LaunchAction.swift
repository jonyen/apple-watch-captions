import Foundation

/// The session the app was last recording into, persisted across launches.
public struct LastSession: Equatable, Sendable {
    /// Transcript this session wrote to, which is also how it is resumed.
    public let transcriptName: String
    public let endedAt: Date

    public init(transcriptName: String, endedAt: Date) {
        self.transcriptName = transcriptName
        self.endedAt = endedAt
    }
}

/// What opening the app should do.
public enum LaunchAction: Equatable, Sendable {
    /// Pick up the previous transcript without asking.
    case resume(name: String)
    /// Offer New / Continue / Browse.
    case menu
}

/// How long after a session ends reopening still counts as the same conversation.
/// Matches the relay's idle-finalize window, so a resumed session lands in the
/// transcript the relay still has open.
public let defaultResumeWindow: TimeInterval = 10 * 60

/// Decide what a launch does.
///
/// Lowering your wrist backgrounds the app, so a short gap means you glanced
/// away mid-conversation and the transcript should continue. A longer gap means
/// a new sitting, and the choice belongs to you.
/// - Parameter stoppedExplicitly: true when the last session ended because the
///   user tapped Stop. That is a decision rather than a pause, so it is never
///   resumed silently no matter how recent it is.
public func launchAction(
    last: LastSession?,
    now: Date,
    stoppedExplicitly: Bool = false,
    window: TimeInterval = defaultResumeWindow
) -> LaunchAction {
    guard let last, !stoppedExplicitly else { return .menu }
    // A negative age is clock skew, not staleness — treat it as current.
    let age = now.timeIntervalSince(last.endedAt)
    return age < window ? .resume(name: last.transcriptName) : .menu
}
