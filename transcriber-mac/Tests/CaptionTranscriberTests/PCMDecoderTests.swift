import XCTest
@testable import caption_transcriber

final class PCMDecoderTests: XCTestCase {
    func testPCM16kWrapsSamplesLosslessly() {
        let d = PCMDecoder(format: .pcm16k)
        let samples: [Int16] = [0, 1000, -1000, Int16.max, Int16.min]
        let data = samples.withUnsafeBytes { Data($0) }
        let buf = d.buffer(from: data)!
        XCTAssertEqual(buf.format.sampleRate, 16_000)
        XCTAssertEqual(buf.frameLength, 5)
        let out = UnsafeBufferPointer(start: buf.int16ChannelData![0], count: 5)
        XCTAssertEqual(Array(out), samples)
    }

    func testMulawDecodesKnownBytes() {
        let d = PCMDecoder(format: .mulaw8k)
        // 0xFF is µ-law for 0; 0x7F is µ-law for the most negative value region.
        let buf = d.buffer(from: Data([0xFF, 0xFF]))!
        XCTAssertEqual(buf.format.sampleRate, 8_000)
        XCTAssertEqual(buf.frameLength, 2)
        let out = UnsafeBufferPointer(start: buf.int16ChannelData![0], count: 2)
        XCTAssertEqual(out[0], 0)   // µ-law 0xFF decodes to 0
    }

    func testOddByteCountPCMDropsTrailingByte() {
        let d = PCMDecoder(format: .pcm16k)
        let buf = d.buffer(from: Data([0x00, 0x01, 0x02]))!
        XCTAssertEqual(buf.frameLength, 1)
    }
}
