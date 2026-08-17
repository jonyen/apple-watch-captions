import XCTest
@testable import CaptionRelay

/// In-memory `SecureTokenStore`. `written` records the last value handed to
/// `write`, distinct from `token` (what `read` returns), so a test can assert
/// persistence without the store silently reading its own writes back.
private final class FakeStore: SecureTokenStore, @unchecked Sendable {
    private var token: String?
    private(set) var written: String?

    init(_ token: String?) {
        self.token = token
    }

    func read() -> String? { token }

    func write(_ token: String) {
        written = token
        self.token = token
    }
}

/// Fake `DeviceRegistrar`. Counts calls so a test can assert the network was
/// (or was not) touched, and can delay its return to make a real race between
/// two concurrent first calls.
private final class FakeRegistrar: DeviceRegistrar, @unchecked Sendable {
    private let result: Result<String, Error>
    private let delayMs: UInt64
    private(set) var calls = 0

    init(returning token: String, delayMs: UInt64 = 0) {
        result = .success(token)
        self.delayMs = delayMs
    }

    init(throwing error: Error) {
        result = .failure(error)
        delayMs = 0
    }

    func register(kind: String) async throws -> String {
        calls += 1
        if delayMs > 0 {
            try? await Task.sleep(nanoseconds: delayMs * 1_000_000)
        }
        return try result.get()
    }
}

private struct RegistrationError: Error, Equatable {
    let message: String
}

final class DeviceRegistrationTests: XCTestCase {
    func testRegistersOnceWhenNoTokenStored() async throws {
        let store = FakeStore(nil)
        let registrar = FakeRegistrar(returning: "tok-A")
        let id = DeviceRegistration(kind: "watch", store: store, registrar: registrar)

        let t = try await id.token()

        XCTAssertEqual(t, "tok-A")
        XCTAssertEqual(store.written, "tok-A")          // persisted
        XCTAssertEqual(registrar.calls, 1)
    }

    func testReturnsStoredTokenWithoutRegistering() async throws {
        let store = FakeStore("tok-existing")
        let registrar = FakeRegistrar(returning: "tok-new")
        let id = DeviceRegistration(kind: "watch", store: store, registrar: registrar)

        let t = try await id.token()

        XCTAssertEqual(t, "tok-existing")
        XCTAssertEqual(registrar.calls, 0)              // no network when already have one
    }

    /// Two `token()` calls race before the first registration completes. Without
    /// the actor serializing access, both would see no stored token and both
    /// would call the registrar; this is the test that pins the actor.
    func testConcurrentFirstCallsRegisterOnce() async throws {
        let store = FakeStore(nil)
        let registrar = FakeRegistrar(returning: "tok-A", delayMs: 20)
        let id = DeviceRegistration(kind: "watch", store: store, registrar: registrar)

        async let a = id.token()
        async let b = id.token()
        let (tokenA, tokenB) = try await (a, b)

        XCTAssertEqual(tokenA, "tok-A")
        XCTAssertEqual(tokenB, "tok-A")
        XCTAssertEqual(registrar.calls, 1)              // the actor serializes it
    }

    /// A registrar failure must propagate, and nothing should be persisted —
    /// a half-registered device would otherwise look successful on retry.
    func testARegistrarFailurePropagatesAndStoresNothing() async {
        let store = FakeStore(nil)
        let registrar = FakeRegistrar(throwing: RegistrationError(message: "offline"))
        let id = DeviceRegistration(kind: "watch", store: store, registrar: registrar)

        do {
            _ = try await id.token()
            XCTFail("expected the registrar's error to propagate")
        } catch {
            XCTAssertEqual(error as? RegistrationError, RegistrationError(message: "offline"))
        }
        XCTAssertNil(store.written)
    }
}
