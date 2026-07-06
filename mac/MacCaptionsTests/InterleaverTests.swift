import XCTest
@testable import MacCaptions

final class InterleaverTests: XCTestCase {
    private func samples(_ data: Data) -> [Int16] {
        data.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
    }

    func testInterleavesEqualLengthSources() {
        let i = Interleaver()
        i.pushMic([1, 2])
        i.pushSystem([10, 20])
        XCTAssertEqual(samples(i.drainStereoFrames()), [1, 10, 2, 20])
    }

    func testPadsShorterSideWithSilence() {
        let i = Interleaver()
        i.pushMic([1, 2, 3])
        i.pushSystem([10])
        XCTAssertEqual(samples(i.drainStereoFrames()), [1, 10, 2, 0, 3, 0])
    }

    func testMissingSourceEntirelyIsSilence() {
        let i = Interleaver()
        i.pushSystem([7])
        XCTAssertEqual(samples(i.drainStereoFrames()), [0, 7])
    }

    func testDrainEmptiesBuffers() {
        let i = Interleaver()
        i.pushMic([1])
        _ = i.drainStereoFrames()
        XCTAssertEqual(i.drainStereoFrames(), Data())
    }
}
