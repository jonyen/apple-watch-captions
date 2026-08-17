import Foundation
import CaptionRelay

/// `DeviceRegistrar` over the relay's one unauthenticated write. No bearer
/// header on this request — registration is what mints the token every other
/// call authenticates with.
public struct RelayDeviceRegistrar: DeviceRegistrar {
    public let base: URL
    private let session = URLSession(configuration: .default)

    public init(base: URL) {
        self.base = base
    }

    public func register(kind: String) async throws -> String {
        var request = URLRequest(url: base.appendingPathComponent("v1/devices"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["kind": kind])

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw RegistrationError.noResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw RegistrationError.badStatus(http.statusCode)
        }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = json["token"] as? String
        else { throw RegistrationError.malformedBody }
        return token
    }
}

public enum RegistrationError: Error, LocalizedError {
    case noResponse
    case badStatus(Int)
    case malformedBody

    /// Short human text — this reaches the UI as-is (`History.swift`'s
    /// `message(from:)` falls back to `error.localizedDescription` for
    /// anything that isn't a `HistoryError`), and the default
    /// `localizedDescription` for an uncustomized `Error` is a paragraph
    /// like "The operation couldn't be completed. (…RegistrationError error
    /// 1.)" — unreadable on a 176px watch screen.
    public var errorDescription: String? {
        switch self {
        case .noResponse: return "Could not reach the relay"
        case .badStatus, .malformedBody: return "Relay error"
        }
    }
}
