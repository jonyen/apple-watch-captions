import XCTest
@testable import CaptionCore

/// The rule that decides what opening the app does. Glancing away mid-conversation
/// should resume silently; a genuinely new sitting should land on the menu.
final class LaunchActionTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_000_000)

    private func session(endedSecondsAgo: TimeInterval) -> LastSession {
        LastSession(transcriptName: "2026-07-25T09-00-00Z_abc",
                    endedAt: now.addingTimeInterval(-endedSecondsAgo))
    }

    func testNoPriorSessionShowsTheMenu() {
        XCTAssertEqual(launchAction(last: nil, now: now), .menu)
    }

    func testRecentSessionResumesSilently() {
        let action = launchAction(last: session(endedSecondsAgo: 60), now: now)
        XCTAssertEqual(action, .resume(name: "2026-07-25T09-00-00Z_abc"))
    }

    func testOldSessionShowsTheMenu() {
        XCTAssertEqual(launchAction(last: session(endedSecondsAgo: 11 * 60), now: now), .menu)
    }

    func testSessionExactlyAtTheWindowShowsTheMenu() {
        // The boundary belongs to "too old" so the rule has one clear meaning:
        // strictly less than the window resumes.
        XCTAssertEqual(launchAction(last: session(endedSecondsAgo: 600), now: now), .menu)
    }

    func testJustInsideTheWindowResumes() {
        let action = launchAction(last: session(endedSecondsAgo: 599), now: now)
        XCTAssertEqual(action, .resume(name: "2026-07-25T09-00-00Z_abc"))
    }

    func testClockSkewIntoTheFutureStillResumes() {
        // A session that claims to have ended slightly in the future is a clock
        // wobble, not a reason to abandon the transcript.
        let action = launchAction(last: session(endedSecondsAgo: -30), now: now)
        XCTAssertEqual(action, .resume(name: "2026-07-25T09-00-00Z_abc"))
    }

    func testWindowIsConfigurable() {
        let action = launchAction(last: session(endedSecondsAgo: 60), now: now, window: 30)
        XCTAssertEqual(action, .menu)
    }

    func testExplicitStopIsNotResumedEvenIfRecent() {
        // Stopping is a decision, not a pause. Reopening should offer the menu.
        let action = launchAction(last: session(endedSecondsAgo: 5), now: now,
                                  stoppedExplicitly: true)
        XCTAssertEqual(action, .menu)
    }

    func testBackgroundingIsStillTreatedAsAPause() {
        let action = launchAction(last: session(endedSecondsAgo: 5), now: now,
                                  stoppedExplicitly: false)
        XCTAssertEqual(action, .resume(name: "2026-07-25T09-00-00Z_abc"))
    }
}
