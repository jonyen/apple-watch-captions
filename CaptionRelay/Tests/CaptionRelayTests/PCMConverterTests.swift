import AVFoundation
import XCTest
@testable import CaptionRelay

final class PCMConverterTests: XCTestCase {
    /// A buffer of audible tone in `sampleRate`/`channels`, `seconds` long.
    private func buffer(sampleRate: Double,
                        channels: AVAudioChannelCount = 1,
                        seconds: Double = 0.1) -> AVAudioPCMBuffer {
        let format = AVAudioFormat(
            commonFormat: .pcmFormatFloat32, sampleRate: sampleRate,
            channels: channels, interleaved: false)!
        let frames = AVAudioFrameCount(sampleRate * seconds)
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames)!
        buffer.frameLength = frames
        for channel in 0..<Int(channels) {
            let samples = buffer.floatChannelData![channel]
            for frame in 0..<Int(frames) {
                samples[frame] = sin(Float(frame) * 0.1) * 0.5
            }
        }
        return buffer
    }

    private func sampleCount(_ data: Data) -> Int {
        data.count / MemoryLayout<Int16>.size
    }

    /// A conversion yields close to `seconds` of 16 kHz audio. Not exact: a
    /// freshly built `AVAudioConverter` withholds a few ms priming its
    /// resampler, so the first buffer through one comes back slightly short.
    /// Production pays that once per session, not per buffer — the converter is
    /// reused across the stream.
    private func assertYields(_ data: Data?, seconds: Double,
                              file: StaticString = #filePath, line: UInt = #line) {
        guard let data else {
            XCTFail("conversion returned nil", file: file, line: line)
            return
        }
        let nominal = 16_000 * seconds
        XCTAssertGreaterThan(Double(sampleCount(data)), nominal * 0.8, file: file, line: line)
        XCTAssertLessThanOrEqual(Double(sampleCount(data)), nominal + 1, file: file, line: line)
    }

    func testResamplesToSixteenKilohertzMonoInt16() {
        assertYields(PCMConverter().convert(buffer(sampleRate: 48_000)), seconds: 0.1)
    }

    /// The bug behind blank captions: `AudioCapture` built one converter from
    /// the format it read at tap-install time. That read happens right after
    /// `setActive(true)`, before the record route is guaranteed established, so
    /// the buffers actually delivered could be in a different format — and
    /// `AVAudioConverter` then fails every conversion. The failure is silent:
    /// no throw, no error state, just a session that captions nothing.
    func testKeepsConvertingWhenTheInputFormatChangesMidStream() {
        let converter = PCMConverter()
        XCTAssertNotNil(converter.convert(buffer(sampleRate: 48_000)))

        let data = converter.convert(buffer(sampleRate: 44_100))

        XCTAssertNotNil(data, "a format change must not silently drop audio")
        assertYields(data, seconds: 0.1)
    }

    func testDownmixesMultichannelInputToMono() {
        assertYields(PCMConverter().convert(buffer(sampleRate: 48_000, channels: 2)), seconds: 0.1)
    }

    func testEmptyBufferProducesNoAudioRatherThanNil() {
        let data = PCMConverter().convert(buffer(sampleRate: 48_000, seconds: 0))

        XCTAssertEqual(data, Data())
    }
}
