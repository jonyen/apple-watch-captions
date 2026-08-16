import Foundation

/// One short line naming the installed build, for the bottom of the home screen.
///
/// The commit is what actually tells two builds apart here — the marketing
/// version barely moves — so it wins over the build number whenever the build
/// was stamped from a git checkout.
public func buildVersionLabel(version: String, build: String?, commit: String?) -> String {
    let version = version.trimmed
    guard let detail = commit.trimmed ?? build.trimmed else { return version }
    guard !version.isEmpty else { return detail }
    return "\(version) (\(detail))"
}

private extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}

private extension Optional where Wrapped == String {
    /// Trimmed, treating whitespace-only as absent — an unstamped plist key and a
    /// blank one mean the same thing.
    var trimmed: String? {
        guard let value = self?.trimmed, !value.isEmpty else { return nil }
        return value
    }
}
