import XCTest
@testable import CaptionCore

private final class FakeVoiceClient: CallVoiceClient, @unchecked Sendable {
    private(set) var sent: [Data] = []
    var error: Error?

    func send(_ pcm: Data) async throws {
        if let error { throw error }
        sent.append(pcm)
    }
}

@MainActor
final class CallVoiceTests: XCTestCase {
    /// Audio captured while not talking is the room, not you. Sending it would
    /// put whatever is around you onto the call.
    func testDiscardsAudioCapturedWhileNotTalking() async {
        let client = FakeVoiceClient()
        let voice = CallVoice(client: client)

        voice.capture(Data([1, 2]))
        await voice.endTalking()

        XCTAssertEqual(client.sent.count, 0)
    }

    func testSendsWhatWasCapturedWhileTalking() async {
        let client = FakeVoiceClient()
        let voice = CallVoice(client: client)

        voice.beginTalking()
        voice.capture(Data([1, 2]))
        voice.capture(Data([3, 4]))
        await voice.endTalking()

        XCTAssertEqual(client.sent, [Data([1, 2, 3, 4])])
    }

    func testReportsWhetherYouAreTalking() async {
        let voice = CallVoice(client: FakeVoiceClient())

        XCTAssertFalse(voice.isTalking)
        voice.beginTalking()
        XCTAssertTrue(voice.isTalking)
        await voice.endTalking()
        XCTAssertFalse(voice.isTalking)
    }

    /// A failed send must still release the button, or the UI shows you as
    /// talking forever.
    func testStopsTalkingEvenWhenTheSendFails() async {
        let client = FakeVoiceClient()
        client.error = HistoryError.message("offline")
        let voice = CallVoice(client: client)

        voice.beginTalking()
        voice.capture(Data([1]))
        await voice.endTalking()

        XCTAssertFalse(voice.isTalking)
    }

    func testASecondTurnDoesNotResendTheFirst() async {
        let client = FakeVoiceClient()
        let voice = CallVoice(client: client)
        voice.beginTalking()
        voice.capture(Data([1]))
        await voice.endTalking()

        voice.beginTalking()
        voice.capture(Data([2]))
        await voice.endTalking()

        XCTAssertEqual(client.sent, [Data([1]), Data([2])])
    }
}
