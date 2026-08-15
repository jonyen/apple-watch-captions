/// What a session does with what it hears.
///
/// A live session has no transcript to append to, so `.live` carries no name.
/// That is the point of the enum over a `Bool` beside `resuming:` — it makes
/// "live and resuming" a state the type system rules out rather than one a
/// guard has to remember to reject.
public enum SessionMode: Equatable, Sendable {
    /// The relay persists captions. `resuming` names an existing transcript to
    /// append to; nil opens a new one.
    case saved(resuming: String?)
    /// Captions reach the screen and nowhere else: the relay writes no file,
    /// runs no summary, and exports nothing.
    case live
}
