import Foundation
import CaptionCore

/// A short-lived code the phone shows and the watch types in to merge their
/// two independently-registered devices onto one user (see `DeviceRegistration`).
/// Six digits, a 10-minute TTL, single use — enforced by the relay, not this
/// type.
public struct PairingCode: Sendable, Equatable {
    public let code: String
    public let expiresAt: Date

    public init(code: String, expiresAt: Date) {
        self.code = code
        self.expiresAt = expiresAt
    }
}

/// The result of typing a code into `POST /v1/pair/claim`.
///
/// `.rejected` covers every reason the relay answers 409 with — unknown,
/// expired, or already-consumed code — collapsed into one case because the
/// watch does the same thing for all three: let the wearer type again. It is
/// not thrown as an error: a mistyped or stale code is the expected shape of
/// this call, not a failure of it.
///
/// A 200 claiming a code issued by one's own user (a documented no-op merge)
/// answers the same shape as a real merge and is not distinguished here —
/// both come back `.paired(userId:)` with that user's id.
public enum ClaimOutcome: Sendable, Equatable {
    case paired(userId: String)
    case rejected(reason: String)
}

/// Issues and claims pairing codes. The phone calls `issueCode()`; the watch
/// calls `claim(code:)`. Both requests are authenticated — unlike
/// registration, which is what mints the token these calls carry.
public protocol PairingClient: Sendable {
    func issueCode() async throws -> PairingCode
    func claim(code: String) async throws -> ClaimOutcome
}

/// A pairing call failed outright — network trouble, a status the contract
/// does not document, or a body that does not parse. Distinct from
/// `ClaimOutcome.rejected`, which is the relay behaving exactly as documented.
public enum PairingError: Error, LocalizedError, Equatable {
    case noResponse
    case badStatus(Int)
    case malformedBody

    /// Short human text — see `RegistrationError.errorDescription`; same
    /// reasoning applies on a watch screen.
    public var errorDescription: String? {
        switch self {
        case .noResponse: return "Could not reach the relay"
        case .badStatus, .malformedBody: return "Relay error"
        }
    }
}

/// Sends a built request and hands back its response — exactly `URLSession`'s
/// `data(for:)` signature, so a real session satisfies it with no glue (see
/// `CaptionRelayLive`'s `RelayPairingClient` initializer, which supplies one).
///
/// Injected here, rather than `RelayPairingClient` calling `URLSession`
/// itself, so the request-building and response-parsing below — the part
/// with actual logic in it, including the 409-does-not-throw mapping — is
/// unit-testable against a fake with no network and no dependency on
/// `CaptionRelayLive`. This keeps `CaptionRelay` free of both `Security` and
/// real networking, per `Package.swift`'s split, while the RelayDeviceRegistrar
/// -style concrete `URLSession` wiring stays in `CaptionRelayLive`.
public typealias PairingTransport = @Sendable (URLRequest) async throws -> (Data, URLResponse)

/// `PairingClient` over the relay's `POST /v1/pair/code` and
/// `POST /v1/pair/claim`. Both carry the device's bearer token, resolved
/// lazily via `token` — a provider rather than a stored `String`, the same
/// reason `HTTPRelayClient` and `RelayDeviceRegistrar` do: the token may not
/// be registered yet when this client is constructed.
public struct RelayPairingClient: PairingClient {
    private let base: URL
    private let token: @Sendable () async throws -> String
    private let transport: PairingTransport

    /// Designated initializer. `transport` has no default here — this type
    /// stays free of `URLSession` so `swift test` never makes a network call.
    /// See `CaptionRelayLive`'s two-argument convenience initializer for the
    /// real `URLSession`-backed one; app code should use that one, and tests
    /// should use this one with a fake.
    public init(base: URL,
                token: @escaping @Sendable () async throws -> String,
                transport: @escaping PairingTransport) {
        self.base = base
        self.token = token
        self.transport = transport
    }

    public func issueCode() async throws -> PairingCode {
        let bearer = try await token()
        var request = URLRequest(url: base.appendingPathComponent("v1/pair/code"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")

        let (data, response) = try await transport(request)
        guard let http = response as? HTTPURLResponse else { throw PairingError.noResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw PairingError.badStatus(http.statusCode)
        }
        guard let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let code = json["code"] as? String,
              let expiresAtRaw = json["expiresAt"] as? String,
              let expiresAt = parseISODate(expiresAtRaw)
        else { throw PairingError.malformedBody }
        return PairingCode(code: code, expiresAt: expiresAt)
    }

    public func claim(code: String) async throws -> ClaimOutcome {
        let bearer = try await token()
        var request = URLRequest(url: base.appendingPathComponent("v1/pair/claim"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["code": code])

        let (data, response) = try await transport(request)
        guard let http = response as? HTTPURLResponse else { throw PairingError.noResponse }

        // A rejected code is a user-retry, not a failure of this call (see
        // `ClaimOutcome`), so it is handled — and returned, not thrown —
        // before the generic status check below that throws for everything
        // else outside 2xx.
        if http.statusCode == 409 {
            let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let reason = (json?["error"] as? String) ?? (json?["message"] as? String)
                ?? "That code didn't work"
            return .rejected(reason: reason)
        }

        guard (200..<300).contains(http.statusCode) else {
            throw PairingError.badStatus(http.statusCode)
        }
        guard let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let userId = json["userId"] as? String
        else { throw PairingError.malformedBody }
        return .paired(userId: userId)
    }
}
