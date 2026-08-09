import XCTest
@testable import CaptionCore

final class MuLawTests: XCTestCase {
    func testDecodesOneSamplePerByte() {
        XCTAssertEqual(MuLaw.decode(Data([0xFF, 0xFF, 0xFF])).count, 3)
    }

    /// 0xFF is mu-law zero. Decoding it as anything else is an audible hiss
    /// under everything the caller says.
    func testSilenceDecodesToZero() {
        XCTAssertEqual(MuLaw.decode(Data([0xFF])), [0])
    }

    /// Must match the relay's encoder exactly, or every call is distorted.
    func testKnownValuesMatchTheRelaysTable() {
        XCTAssertEqual(MuLaw.decode(Data([0x00])), [-32124])
        XCTAssertEqual(MuLaw.decode(Data([0x80])), [32124])
        XCTAssertEqual(MuLaw.decode(Data([0x7F])), [0])
    }

    func testEmptyInputDecodesToNothing() {
        XCTAssertEqual(MuLaw.decode(Data()), [])
    }
}
