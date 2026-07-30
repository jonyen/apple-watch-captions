import Foundation
import CaptionCore

/// Which build is installed, read from the bundle. `GitCommit` is written into
/// the built Info.plist by `Scripts/stamp-git-commit.sh` at compile time.
enum AppBuild {
    static let versionLabel: String = {
        let info = Bundle.main.infoDictionary
        return buildVersionLabel(
            version: info?["CFBundleShortVersionString"] as? String ?? "",
            build: info?["CFBundleVersion"] as? String,
            commit: info?["GitCommit"] as? String)
    }()
}
