import XCTest
@testable import TranscriberCore

final class WavDataChunkTests: XCTestCase {
    private func chunk(_ id: String, _ body: [UInt8]) -> Data {
        var d = Data(id.utf8)
        d.append(contentsOf: withUnsafeBytes(of: UInt32(body.count).littleEndian, Array.init))
        d.append(contentsOf: body)
        if body.count % 2 != 0 { d.append(0) }  // RIFF chunks are word-aligned
        return d
    }

    private func riff(_ chunks: Data...) -> Data {
        let body = Data("WAVE".utf8) + chunks.reduce(Data(), +)
        var d = Data("RIFF".utf8)
        d.append(contentsOf: withUnsafeBytes(of: UInt32(body.count).littleEndian, Array.init))
        d.append(body)
        return d
    }

    func testFindsDataAfterFmtAndFillerChunks() {
        // CoreAudio layout: fmt, then an FLLR filler, then data.
        let wav = riff(chunk("fmt ", Array(repeating: 0, count: 16)),
                       chunk("FLLR", Array(repeating: 0, count: 10)),
                       chunk("data", [1, 2, 3, 4]))
        XCTAssertEqual(wavDataChunk(wav), Data([1, 2, 3, 4]))
    }

    func testGarbageAndShortInputsReturnNilWithoutCrashing() {
        XCTAssertNil(wavDataChunk(Data()))
        XCTAssertNil(wavDataChunk(Data("RIFF".utf8)))
        XCTAssertNil(wavDataChunk(Data("RIFF\0\0\0\0WAVE".utf8)))          // no chunks
        XCTAssertNil(wavDataChunk(Data("NOPE\0\0\0\0WAVE".utf8)))          // not RIFF
        XCTAssertNil(wavDataChunk(Data(repeating: 0xAB, count: 64)))       // garbage
        XCTAssertNil(wavDataChunk(riff(chunk("fmt ", [0, 0]))))            // no data chunk
        // Truncated chunk header (7 bytes after WAVE) must not read out of bounds.
        XCTAssertNil(wavDataChunk(Data("RIFF\u{0F}\0\0\0WAVEdata\0\0\0".utf8)))
    }

    func testDataSizeLargerThanFileIsClampedNotCrashing() {
        var wav = Data("RIFF".utf8)
        wav.append(contentsOf: withUnsafeBytes(of: UInt32(100).littleEndian, Array.init))
        wav.append(Data("WAVEdata".utf8))
        wav.append(contentsOf: withUnsafeBytes(of: UInt32(1000).littleEndian, Array.init))  // lies
        wav.append(Data([9, 8, 7]))
        XCTAssertEqual(wavDataChunk(wav), Data([9, 8, 7]))
    }

    func testOddSizedChunkPaddingIsSkipped() {
        let wav = riff(chunk("junk", [0xFF, 0xFF, 0xFF]),  // odd size -> pad byte
                       chunk("data", [5, 6]))
        XCTAssertEqual(wavDataChunk(wav), Data([5, 6]))
    }
}
