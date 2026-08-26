import Foundation

/// Extracts the `data` chunk payload from a RIFF/WAVE file. Walks chunks
/// rather than assuming a 44-byte header — afconvert/CoreAudio WAVs carry an
/// `FLLR` filler chunk, so audio often starts at offset 4096. Format checking
/// is the caller's problem; our test clips are 16 kHz mono Int16.
public func wavDataChunk(_ wav: Data) -> Data? {
    guard wav.count > 12, wav.prefix(4) == Data("RIFF".utf8),
          wav.subdata(in: 8..<12) == Data("WAVE".utf8) else { return nil }
    var offset = 12
    while offset + 8 <= wav.count {
        let id = wav.subdata(in: offset..<offset + 4)
        let size = wav.subdata(in: offset + 4..<offset + 8)
            .withUnsafeBytes { Int($0.loadUnaligned(as: UInt32.self).littleEndian) }
        let body = offset + 8
        if id == Data("data".utf8) {
            return wav.subdata(in: body..<min(body + size, wav.count))
        }
        offset = body + size + (size & 1)
    }
    return nil
}
