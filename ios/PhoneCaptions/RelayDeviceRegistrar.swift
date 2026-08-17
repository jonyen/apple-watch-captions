import Foundation
import CaptionRelay

/// `DeviceRegistrar` over the relay's one unauthenticated write. No bearer
/// header on this request — registration is what mints the token every other
/// call authenticates with.
struct RelayDeviceRegistrar: DeviceRegistrar {
    let base: URL
    private let session = URLSession(configuration: .default)

    func register(kind: String) async throws -> String {
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

enum RegistrationError: Error {
    case noResponse
    case badStatus(Int)
    case malformedBody
}
