import XCTest
@testable import CaptionRelay

/// Records the request it was handed and answers a scripted response, so a
/// test can assert what `RelayPairingClient` sent without making a network
/// call. Mirrors the token-provider fakes elsewhere in this suite (e.g.
/// `DeviceRegistrationTests.FakeRegistrar`), one layer lower: this fakes the
/// transport `RelayPairingClient` is injected with, not the whole client.
private final class FakeTransport: @unchecked Sendable {
    private(set) var requests: [URLRequest] = []
    private var result: Result<(Data, URLResponse), Error>

    init(status: Int, body: [String: Any]) {
        result = .success(FakeTransport.response(status: status, body: body))
    }

    init(status: Int, bodyData: Data) {
        result = .success((bodyData, FakeTransport.httpResponse(status: status)))
    }

    init(throwing error: Error) {
        result = .failure(error)
    }

    func send(_ request: URLRequest) async throws -> (Data, URLResponse) {
        requests.append(request)
        return try result.get()
    }

    var handler: PairingTransport { { try await self.send($0) } }

    private static func response(status: Int, body: [String: Any]) -> (Data, URLResponse) {
        let data = try! JSONSerialization.data(withJSONObject: body)
        return (data, httpResponse(status: status))
    }

    private static func httpResponse(status: Int) -> URLResponse {
        HTTPURLResponse(url: URL(string: "https://relay.example")!, statusCode: status,
                        httpVersion: "HTTP/1.1", headerFields: nil)!
    }
}

private struct TransportError: Error, Equatable {
    let message: String
}

private let base = URL(string: "https://relay.example")!

private func makeClient(_ transport: FakeTransport, token: String = "tok-A") -> RelayPairingClient {
    RelayPairingClient(base: base, token: { token }, transport: transport.handler)
}

final class PairingTests: XCTestCase {

    // MARK: - issueCode

    func testIssueCodeParsesTheCodeAndExpiry() async throws {
        let transport = FakeTransport(
            status: 200, body: ["code": "483920", "expiresAt": "2026-08-16T12:00:00Z"])
        let client = makeClient(transport)

        let pairing = try await client.issueCode()

        XCTAssertEqual(pairing.code, "483920")
        XCTAssertEqual(pairing.expiresAt.timeIntervalSince1970,
                       DateComponents(calendar: .init(identifier: .gregorian),
                                      timeZone: TimeZone(identifier: "UTC"),
                                      year: 2026, month: 8, day: 16,
                                      hour: 12, minute: 0, second: 0).date!.timeIntervalSince1970,
                       accuracy: 0.001)
    }

    func testIssueCodeSendsAPOSTWithTheBearerHeader() async throws {
        let transport = FakeTransport(
            status: 200, body: ["code": "483920", "expiresAt": "2026-08-16T12:00:00Z"])
        let client = makeClient(transport, token: "tok-phone")

        _ = try await client.issueCode()

        XCTAssertEqual(transport.requests.count, 1)
        let request = transport.requests[0]
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url, base.appendingPathComponent("v1/pair/code"))
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer tok-phone")
    }

    func testIssueCodeThrowsOnAMalformedBody() async {
        let transport = FakeTransport(status: 200, body: ["code": "483920"])   // no expiresAt
        let client = makeClient(transport)

        do {
            _ = try await client.issueCode()
            XCTFail("expected a malformed body to throw")
        } catch {
            XCTAssertEqual(error as? PairingError, .malformedBody)
        }
    }

    func testIssueCodeThrowsOnANonSuccessStatusThatIsNot409() async {
        let transport = FakeTransport(status: 500, body: [:])
        let client = makeClient(transport)

        do {
            _ = try await client.issueCode()
            XCTFail("expected a 500 to throw")
        } catch {
            XCTAssertEqual(error as? PairingError, .badStatus(500))
        }
    }

    // MARK: - claim

    func testClaimMapsA200ToPaired() async throws {
        let transport = FakeTransport(status: 200, body: ["userId": "user-123"])
        let client = makeClient(transport)

        let outcome = try await client.claim(code: "483920")

        XCTAssertEqual(outcome, .paired(userId: "user-123"))
    }

    /// The load-bearing case: a 409 must come back as `.rejected`, not throw.
    /// A rejected code is a user-retry (mistyped, expired, already used), and
    /// Task 6's UI decides what to show on it — nothing here should route it
    /// through an error-handling path meant for genuine failures.
    func testClaimMapsA409ToRejectedWithoutThrowing() async throws {
        let transport = FakeTransport(status: 409, body: ["error": "unknown or expired code"])
        let client = makeClient(transport)

        let outcome = try await client.claim(code: "000000")

        XCTAssertEqual(outcome, .rejected(reason: "unknown or expired code"))
    }

    /// The relay's 409 contract does not document a body shape. A 409 with no
    /// parseable body must still come back `.rejected`, not throw — the
    /// no-throw guarantee cannot depend on the relay sending an error string.
    func testClaimMapsA409WithNoBodyToRejectedWithoutThrowing() async throws {
        let transport = FakeTransport(status: 409, bodyData: Data())
        let client = makeClient(transport)

        let outcome = try await client.claim(code: "000000")

        guard case .rejected = outcome else {
            return XCTFail("expected .rejected, got \(outcome)")
        }
    }

    func testClaimThrowsOnAMalformedBody() async {
        let transport = FakeTransport(status: 200, body: ["nope": "not a userId"])
        let client = makeClient(transport)

        do {
            _ = try await client.claim(code: "483920")
            XCTFail("expected a malformed body to throw")
        } catch {
            XCTAssertEqual(error as? PairingError, .malformedBody)
        }
    }

    func testClaimThrowsOnANonSuccessStatusThatIsNot409() async {
        let transport = FakeTransport(status: 500, body: [:])
        let client = makeClient(transport)

        do {
            _ = try await client.claim(code: "483920")
            XCTFail("expected a 500 to throw")
        } catch {
            XCTAssertEqual(error as? PairingError, .badStatus(500))
        }
    }

    func testClaimThrowsWhateverTheTransportThrows() async {
        let transport = FakeTransport(throwing: TransportError(message: "offline"))
        let client = makeClient(transport)

        do {
            _ = try await client.claim(code: "483920")
            XCTFail("expected the transport's error to propagate")
        } catch {
            XCTAssertEqual(error as? TransportError, TransportError(message: "offline"))
        }
    }

    func testClaimSendsTheCodeAsItsBodyWithTheBearerHeader() async throws {
        let transport = FakeTransport(status: 200, body: ["userId": "user-123"])
        let client = makeClient(transport, token: "tok-watch")

        _ = try await client.claim(code: "483920")

        XCTAssertEqual(transport.requests.count, 1)
        let request = transport.requests[0]
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url, base.appendingPathComponent("v1/pair/claim"))
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer tok-watch")

        let body = try XCTUnwrap(request.httpBody)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(json["code"] as? String, "483920")
    }
}
