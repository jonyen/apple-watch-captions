import XCTest
@testable import CaptionRelay

/// The one line at the bottom of the home screen naming which build is installed.
final class BuildInfoTests: XCTestCase {
    func testCommitIdentifiesTheBuild() {
        XCTAssertEqual(buildVersionLabel(version: "1.0", build: "1", commit: "7664d60"),
                       "1.0 (7664d60)")
    }

    func testFallsBackToTheBuildNumberWithoutACommit() {
        // Builds from a tarball or an archive have no git checkout to ask.
        XCTAssertEqual(buildVersionLabel(version: "1.0", build: "12", commit: nil),
                       "1.0 (12)")
    }

    func testEmptyCommitCountsAsMissing() {
        XCTAssertEqual(buildVersionLabel(version: "1.0", build: "12", commit: "  "),
                       "1.0 (12)")
    }

    func testVersionAloneWhenNothingIdentifiesTheBuild() {
        XCTAssertEqual(buildVersionLabel(version: "1.0", build: nil, commit: nil), "1.0")
        XCTAssertEqual(buildVersionLabel(version: "1.0", build: "", commit: ""), "1.0")
    }

    func testCommitAloneWhenTheBundleHasNoVersion() {
        // Never render a stray "(abc1234)" with nothing in front of it.
        XCTAssertEqual(buildVersionLabel(version: "", build: nil, commit: "7664d60"), "7664d60")
    }

    func testEmptyBundleGivesAnEmptyLabel() {
        XCTAssertEqual(buildVersionLabel(version: "", build: nil, commit: nil), "")
    }

    func testSurroundingWhitespaceIsTrimmed() {
        XCTAssertEqual(buildVersionLabel(version: " 1.0 ", build: nil, commit: " 7664d60\n"),
                       "1.0 (7664d60)")
    }

    func testTheDirtyMarkerSurvives() {
        // A build made with uncommitted changes is stamped "abc1234*", and that
        // asterisk is the whole point of the marker.
        XCTAssertEqual(buildVersionLabel(version: "1.0", build: "1", commit: "7664d60*"),
                       "1.0 (7664d60*)")
    }
}
