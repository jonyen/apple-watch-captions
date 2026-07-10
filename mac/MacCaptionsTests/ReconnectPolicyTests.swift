import XCTest
@testable import Captions

final class ReconnectPolicyTests: XCTestCase {
    func testBacksOffAndCaps() {
        var p = ReconnectPolicy()
        XCTAssertEqual(p.nextDelay(), 0.5)
        XCTAssertEqual(p.nextDelay(), 1.0)
        XCTAssertEqual(p.nextDelay(), 2.0)
        XCTAssertEqual(p.nextDelay(), 4.0)
        XCTAssertEqual(p.nextDelay(), 8.0)
        XCTAssertEqual(p.nextDelay(), 8.0)
    }

    func testGivesUpAfterMaxElapsed() {
        var p = ReconnectPolicy()
        var total: TimeInterval = 0
        while let d = p.nextDelay() { total += d }
        XCTAssertGreaterThanOrEqual(total, 30)
        XCTAssertNil(p.nextDelay())
    }

    func testResetRestoresBudget() {
        var p = ReconnectPolicy()
        _ = p.nextDelay(); _ = p.nextDelay()
        p.reset()
        XCTAssertEqual(p.nextDelay(), 0.5)
    }
}
