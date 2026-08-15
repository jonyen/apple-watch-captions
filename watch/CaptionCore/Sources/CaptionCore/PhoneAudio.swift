/// The relay session that carries audio playing on the iPhone.
///
/// Two devices have to agree on one session id without ever talking to each
/// other: the phone's broadcast extension posts audio into it, and the Watch
/// posts empty bodies to the same id to drain the captions back out. The relay
/// keys `feed` and `drain` by session and tracks the cursor per request, so a
/// producer and a reader share a session without either knowing about the other.
///
/// A fixed string rather than something negotiated, because negotiation needs a
/// channel these two do not have. A broadcast extension cannot reach the app
/// that contains it without an App Group, which is a paid-membership capability,
/// so there is nowhere to put a value the phone picks at runtime.
public enum PhoneAudio {
    public static let sessionID = "phone-audio"
}
