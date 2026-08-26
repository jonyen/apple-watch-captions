import XCTest
@testable import CaptionRelay

final class PhoneWireTests: XCTestCase {

    // MARK: - begin

    func testRoundTripBeginWithToken() {
        let msg = PhoneWire.Message.begin(.init(sessionId: "abc-123", keep: true, token: "tok_xyz"))
        let data = PhoneWire.encode(msg)
        XCTAssertEqual(data.first, 1)
        XCTAssertEqual(PhoneWire.decode(data), msg)
    }

    func testRoundTripBeginWithoutToken() {
        let msg = PhoneWire.Message.begin(.init(sessionId: "abc-123", keep: false, token: nil))
        let data = PhoneWire.encode(msg)
        XCTAssertEqual(data.first, 1)
        XCTAssertEqual(PhoneWire.decode(data), msg)
    }

    // MARK: - audio

    func testRoundTripAudioLargeSeqAnd8KBPayload() {
        let seq = Int(Int64(Int32.max)) + 12345 // > 2^31
        let pcm = Data((0..<8192).map { UInt8($0 % 256) })
        let msg = PhoneWire.Message.audio(.init(seq: seq, pcm: pcm))
        let data = PhoneWire.encode(msg)
        XCTAssertEqual(data.first, 2)
        guard case .audio(let decoded)? = PhoneWire.decode(data) else {
            XCTFail("expected audio message")
            return
        }
        XCTAssertEqual(decoded.seq, seq)
        XCTAssertEqual(decoded.pcm, pcm, "PCM payload must be byte-identical")
        XCTAssertEqual(PhoneWire.decode(data), msg)
    }

    func testAudioHeaderLayout() {
        let seq: Int = 42
        let pcm = Data([0xAA, 0xBB, 0xCC])
        let data = PhoneWire.encode(.audio(.init(seq: seq, pcm: pcm)))
        XCTAssertEqual(data.count, 1 + 8 + 3)
        // little-endian Int64 seq at bytes 1...8
        let seqBytes = data.subdata(in: 1..<9)
        var decodedSeq: Int64 = 0
        for (i, byte) in seqBytes.enumerated() {
            decodedSeq |= Int64(byte) << (8 * i)
        }
        XCTAssertEqual(decodedSeq, Int64(seq))
        XCTAssertEqual(data.suffix(from: 9), pcm)
    }

    // MARK: - finish / ready

    func testRoundTripFinishIsOneByte() {
        let data = PhoneWire.encode(.finish)
        XCTAssertEqual(data, Data([3]))
        XCTAssertEqual(PhoneWire.decode(data), .finish)
    }

    func testRoundTripReadyIsOneByte() {
        let data = PhoneWire.encode(.ready)
        XCTAssertEqual(data, Data([4]))
        XCTAssertEqual(PhoneWire.decode(data), .ready)
    }

    // MARK: - caption

    func testRoundTripCaptionPartial() {
        let msg = PhoneWire.Message.caption(.init(text: "hello wor", isFinal: false))
        let data = PhoneWire.encode(msg)
        XCTAssertEqual(data.first, 5)
        XCTAssertEqual(PhoneWire.decode(data), msg)
    }

    func testRoundTripCaptionFinal() {
        let msg = PhoneWire.Message.caption(.init(text: "hello world", isFinal: true))
        let data = PhoneWire.encode(msg)
        XCTAssertEqual(data.first, 5)
        XCTAssertEqual(PhoneWire.decode(data), msg)
    }

    // MARK: - caption sessionId (wire amendment: additive, backward-compatible)

    func testRoundTripCaptionWithSessionId() {
        let msg = PhoneWire.Message.caption(.init(text: "hello", isFinal: true, sessionId: "sess-1"))
        let data = PhoneWire.encode(msg)
        XCTAssertEqual(data.first, 5)
        XCTAssertEqual(PhoneWire.decode(data), msg)
    }

    func testRoundTripCaptionWithoutSessionIdStillDecodesNil() {
        let msg = PhoneWire.Message.caption(.init(text: "hello", isFinal: false))
        let data = PhoneWire.encode(msg)
        guard case .caption(let caption)? = PhoneWire.decode(data) else {
            XCTFail("expected caption message")
            return
        }
        XCTAssertNil(caption.sessionId)
        XCTAssertEqual(PhoneWire.decode(data), msg)
    }

    func testDecodeOldFormatCaptionJSONWithoutSessionIdFieldDecodesNil() {
        // Simulates a caption frame from a peer that predates the sessionId
        // field entirely — the JSON body has no "sessionId" key at all.
        var data = Data([5])
        data.append(contentsOf: #"{"text":"hi","isFinal":false}"#.utf8)
        guard case .caption(let caption)? = PhoneWire.decode(data) else {
            XCTFail("expected caption message")
            return
        }
        XCTAssertEqual(caption.text, "hi")
        XCTAssertEqual(caption.isFinal, false)
        XCTAssertNil(caption.sessionId)
    }

    // MARK: - error

    func testRoundTripError() {
        let msg = PhoneWire.Message.error("something went wrong")
        let data = PhoneWire.encode(msg)
        XCTAssertEqual(data.first, 6)
        XCTAssertEqual(PhoneWire.decode(data), msg)
    }

    // MARK: - shareIdentity (amendment: tag 7)

    func testRoundTripShareIdentity() {
        let msg = PhoneWire.Message.shareIdentity(token: "bearer_tok_123")
        let data = PhoneWire.encode(msg)
        XCTAssertEqual(data.first, 7)
        XCTAssertEqual(PhoneWire.decode(data), msg)
    }

    func testDecodeShareIdentityMalformedJSONReturnsNil() {
        var data = Data([7])
        data.append(contentsOf: "{not json".utf8)
        XCTAssertNil(PhoneWire.decode(data))
    }

    // MARK: - decode failure cases

    func testDecodeEmptyDataReturnsNil() {
        XCTAssertNil(PhoneWire.decode(Data()))
    }

    func testDecodeUnknownTagReturnsNil() {
        XCTAssertNil(PhoneWire.decode(Data([99])))
    }

    func testDecodeTruncatedAudioHeaderReturnsNil() {
        // tag byte + fewer than 8 bytes for the seq header
        let data = Data([2, 0x01, 0x02, 0x03])
        XCTAssertNil(PhoneWire.decode(data))
    }

    func testDecodeMalformedJSONBeginReturnsNil() {
        var data = Data([1])
        data.append(contentsOf: "{not valid json".utf8)
        XCTAssertNil(PhoneWire.decode(data))
    }

    func testDecodeMalformedJSONCaptionReturnsNil() {
        var data = Data([5])
        data.append(contentsOf: "not even json-ish {{{".utf8)
        XCTAssertNil(PhoneWire.decode(data))
    }

    func testDecodeMalformedJSONErrorReturnsNil() {
        var data = Data([6])
        data.append(contentsOf: "[1,2,".utf8)
        XCTAssertNil(PhoneWire.decode(data))
    }
}
