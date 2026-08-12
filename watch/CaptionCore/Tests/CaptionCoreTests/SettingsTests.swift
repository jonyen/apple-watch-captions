import XCTest
@testable import CaptionCore

final class SettingsTests: XCTestCase {
    func testEmptyResponseYieldsDefaults() {
        XCTAssertEqual(decodeSettings([:]), Settings.defaults)
    }

    func testDecodesEveryField() {
        let settings = decodeSettings([
            "captionTextSize": 22.0,
            "autoOpenPhoneAudio": false,
            "saveTranscripts": false,
        ])

        XCTAssertEqual(settings.captionTextSize, 22)
        XCTAssertFalse(settings.autoOpenPhoneAudio)
        XCTAssertFalse(settings.saveTranscripts)
    }

    /// JSONSerialization hands back whole numbers as Int, so a relay that
    /// stores 20 rather than 20.0 must not silently fall back to the default.
    func testDecodesAnIntegerTextSize() {
        XCTAssertEqual(decodeSettings(["captionTextSize": 20]).captionTextSize, 20)
    }

    /// Each field falls back on its own: a relay predating one setting, or one
    /// version ahead, should not revert everything the watch knows.
    func testUnknownAndMissingFieldsLeaveOthersIntact() {
        let settings = decodeSettings(["captionTextSize": 24, "somethingNewer": true])

        XCTAssertEqual(settings.captionTextSize, 24)
        XCTAssertEqual(settings.saveTranscripts, Settings.defaults.saveTranscripts)
    }

    func testWrongTypesFallBackRatherThanCrash() {
        let settings = decodeSettings([
            "captionTextSize": "big",
            "autoOpenPhoneAudio": "yes",
        ])

        XCTAssertEqual(settings, Settings.defaults)
    }

    func testDecodesPresence() {
        XCTAssertEqual(decodePresence(["reader": true, "producer": true]),
                       Presence(reader: true, producer: true))
        XCTAssertEqual(decodePresence([:]), Presence(reader: false, producer: false))
    }
}
