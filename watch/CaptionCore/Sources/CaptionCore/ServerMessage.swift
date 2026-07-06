import Foundation

/// A message received from the caption relay.
public enum ServerMessage: Equatable {
    case ready
    case caption(text: String, isFinal: Bool, channel: Int?)
    case error(message: String)
}

extension ServerMessage: Decodable {
    private enum CodingKeys: String, CodingKey { case type, text, isFinal, message, channel }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .type) {
        case "ready":
            self = .ready
        case "caption":
            self = .caption(
                text: try c.decode(String.self, forKey: .text),
                isFinal: try c.decode(Bool.self, forKey: .isFinal),
                channel: try c.decodeIfPresent(Int.self, forKey: .channel)
            )
        case "error":
            self = .error(message: try c.decode(String.self, forKey: .message))
        case let other:
            throw DecodingError.dataCorruptedError(
                forKey: .type, in: c, debugDescription: "unknown message type \(other)")
        }
    }
}

public extension ServerMessage {
    /// Decode a UTF-8 JSON payload from the relay.
    static func decode(_ data: Data) throws -> ServerMessage {
        try JSONDecoder().decode(ServerMessage.self, from: data)
    }
}
