import os

/// Where the extension's diagnostics go.
///
/// The extension is a separate process with no UI, so anything it notices has to
/// reach you some other way. The obvious channel — a file in a shared App Group
/// container — needs a paid membership, so this uses unified logging: both
/// processes write to the same subsystem, the system merges them in timestamp
/// order, and the Mac reads them back off the device afterwards.
///
/// That suits a broadcast anyway. The phone is usually not next to the Mac while
/// one is running, and `notice` is persisted to disk rather than held in a
/// memory-only ring buffer, so the record survives the broadcast ending and the
/// phone being away for an hour.
///
/// See `ios/README.md` for the commands that read it back.
enum UploadLog {
    static let subsystem = "com.jonyen.phonecaptions"

    private static let logger = Logger(subsystem: subsystem, category: "upload")

    /// Logs one line. `privacy: .public` is required — interpolated values are
    /// redacted to `<private>` by default, which would hide the detail worth
    /// logging in the first place.
    static func append(_ message: String) {
        logger.notice("\(message, privacy: .public)")
    }
}
