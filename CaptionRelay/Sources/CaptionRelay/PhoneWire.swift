import Foundation

/// Wire protocol for the watch<->phone transcription channel.
///
/// Encoding: byte 0 is a type tag. For `begin`/`caption`/`error`/`shareIdentity`
/// the remainder is a JSON body. For `audio` the remainder is bytes 1...8 as a
/// little-endian `Int64` sequence number followed by raw PCM bytes (no JSON on
/// the hot path). `finish` and `ready` are one byte (just the tag).
public enum PhoneWire {
    private enum Tag: UInt8 {
        case begin = 1
        case audio = 2
        case finish = 3
        case ready = 4
        case caption = 5
        case error = 6
        case shareIdentity = 7
    }

    public struct Begin: Codable, Equatable {
        public let sessionId: String
        public let keep: Bool
        public let token: String?      // present only when keep

        public init(sessionId: String, keep: Bool, token: String?) {
            self.sessionId = sessionId
            self.keep = keep
            self.token = token
        }
    }

    public struct Audio: Equatable {
        public let seq: Int
        public let pcm: Data

        public init(seq: Int, pcm: Data) {
            self.seq = seq
            self.pcm = pcm
        }
    }

    public struct Caption: Codable, Equatable {
        public let text: String
        public let isFinal: Bool
        /// Which session sent this — additive and optional so older peers
        /// (and this codebase's own pre-Task-8 wire frames) keep decoding: a
        /// missing key decodes as `nil` via Swift's synthesized
        /// `decodeIfPresent`, and encoding a `nil` value omits the key
        /// entirely via the matching `encodeIfPresent`, so the JSON shape is
        /// byte-identical to before whenever a caller doesn't pass one.
        /// `PhoneEngine` uses it to drop a straggler caption from a session
        /// it has already moved past (see its `handle(_:)`).
        public let sessionId: String?

        public init(text: String, isFinal: Bool, sessionId: String? = nil) {
            self.text = text
            self.isFinal = isFinal
            self.sessionId = sessionId
        }
    }

    private struct ErrorBody: Codable {
        let message: String
    }

    private struct ShareIdentityBody: Codable {
        let token: String
    }

    public enum Message: Equatable {
        case begin(Begin)
        case audio(Audio)
        case finish
        case ready
        case caption(Caption)
        case error(String)
        case shareIdentity(token: String)
    }

    public static func encode(_ message: Message) -> Data {
        switch message {
        case .begin(let begin):
            return encodeJSON(tag: .begin, body: begin)
        case .audio(let audio):
            var data = Data(capacity: 1 + 8 + audio.pcm.count)
            data.append(Tag.audio.rawValue)
            var seq = Int64(audio.seq).littleEndian
            withUnsafeBytes(of: &seq) { data.append(contentsOf: $0) }
            data.append(audio.pcm)
            return data
        case .finish:
            return Data([Tag.finish.rawValue])
        case .ready:
            return Data([Tag.ready.rawValue])
        case .caption(let caption):
            return encodeJSON(tag: .caption, body: caption)
        case .error(let message):
            return encodeJSON(tag: .error, body: ErrorBody(message: message))
        case .shareIdentity(let token):
            return encodeJSON(tag: .shareIdentity, body: ShareIdentityBody(token: token))
        }
    }

    public static func decode(_ data: Data) -> Message? {
        guard let tagByte = data.first, let tag = Tag(rawValue: tagByte) else {
            return nil
        }
        let body = data.dropFirst()

        switch tag {
        case .begin:
            guard let begin = try? JSONDecoder().decode(Begin.self, from: body) else { return nil }
            return .begin(begin)
        case .audio:
            guard body.count >= 8 else { return nil }
            let seqBytes = body.prefix(8)
            var seq: Int64 = 0
            withUnsafeMutableBytes(of: &seq) { dest in
                dest.copyBytes(from: seqBytes)
            }
            seq = Int64(littleEndian: seq)
            let pcm = Data(body.dropFirst(8))
            return .audio(Audio(seq: Int(seq), pcm: pcm))
        case .finish:
            return .finish
        case .ready:
            return .ready
        case .caption:
            guard let caption = try? JSONDecoder().decode(Caption.self, from: body) else { return nil }
            return .caption(caption)
        case .error:
            guard let errorBody = try? JSONDecoder().decode(ErrorBody.self, from: body) else { return nil }
            return .error(errorBody.message)
        case .shareIdentity:
            guard let shareBody = try? JSONDecoder().decode(ShareIdentityBody.self, from: body) else { return nil }
            return .shareIdentity(token: shareBody.token)
        }
    }

    private static func encodeJSON<T: Encodable>(tag: Tag, body: T) -> Data {
        var data = Data([tag.rawValue])
        if let json = try? JSONEncoder().encode(body) {
            data.append(json)
        }
        return data
    }
}
