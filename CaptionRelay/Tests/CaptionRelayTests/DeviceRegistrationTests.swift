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

/// Fake `DeviceRegistrar` that always answers with a fixed token. Counts
/// calls so a test can assert the network was (or was not) touched.
private final class FakeRegistrar: DeviceRegistrar, @unchecked Sendable {
    private let result: Result<String, Error>
    private(set) var calls = 0

    init(returning token: String) {
        result = .success(token)
    }

    init(throwing error: Error) {
        result = .failure(error)
    }

    func register(kind: String) async throws -> String {
        calls += 1
        return try result.get()
    }
}

/// A `DeviceRegistrar` that replays one scripted outcome per call, in order —
/// used to prove a failed registration is retried cleanly on the next call
/// rather than leaving the actor's in-flight state poisoned.
private final class ScriptedRegistrar: DeviceRegistrar, @unchecked Sendable {
    private var results: [Result<String, Error>]
    private(set) var calls = 0

    init(_ results: [Result<String, Error>]) {
        self.results = results
    }

    func register(kind: String) async throws -> String {
        calls += 1
        precondition(!results.isEmpty, "test called the registrar more times than scripted")
        return try results.removeFirst().get()
    }
}

/// A `DeviceRegistrar` whose `register(kind:)` calls block until a test
/// releases them, so a second `token()` call racing the first can be proven
/// to have been issued while the first registration is still in flight,
/// instead of hoping a fixed delay is long enough. Mirrors
/// `CallCaptionsTests.GatedCallClient`.
private actor GatedRegistrar: DeviceRegistrar {
    private var waiters: [CheckedContinuation<String, Error>] = []
    private var arrivalWatchers: [(need: Int, continuation: CheckedContinuation<Void, Never>)] = []
    private(set) var calls = 0

    func register(kind: String) async throws -> String {
        calls += 1
        notifyArrivals()
        return try await withCheckedThrowingContinuation { waiters.append($0) }
    }

    /// Waits until `count` calls have arrived, without releasing them.
    func waitForArrival(_ count: Int) async {
        if calls < count {
            await withCheckedContinuation { arrivalWatchers.append((count, $0)) }
        }
    }

    /// Resolves every call currently waiting with `token`.
    func releaseAll(with token: String) {
        let toResume = waiters
        waiters.removeAll()
        toResume.forEach { $0.resume(returning: token) }
    }

    private func notifyArrivals() {
        arrivalWatchers.removeAll { watcher in
            guard calls >= watcher.need else { return false }
            watcher.continuation.resume()
            return true
        }
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

    /// Two `token()` calls race before the first registration completes. The
    /// registrar blocks the first call until the test explicitly releases
    /// it, so the second call is provably issued while the first is still in
    /// flight — a fact the test establishes, not a timing hope. Without the
    /// actor's in-flight coalescing, both would see no stored token and both
    /// would call the registrar; this is the test that pins the actor.
    func testConcurrentFirstCallsRegisterOnce() async throws {
        let store = FakeStore(nil)
        let registrar = GatedRegistrar()
        let id = DeviceRegistration(kind: "watch", store: store, registrar: registrar)

        async let a = id.token()
        await registrar.waitForArrival(1)   // the first call is now blocked in the registrar

        async let b = id.token()
        await registrar.releaseAll(with: "tok-A")

        let (tokenA, tokenB) = try await (a, b)
        let calls = await registrar.calls

        XCTAssertEqual(tokenA, "tok-A")
        XCTAssertEqual(tokenB, "tok-A")
        XCTAssertEqual(calls, 1)                        // the actor coalesced them
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

    /// A failed registration must not poison the in-flight task: the `defer`
    /// that clears it has to run on the error path too, or a call after a
    /// failure would either hang awaiting a task that already failed, or
    /// silently reuse that failure instead of retrying. This is the test
    /// that would fail if the `defer` were moved or made conditional.
    func testARetryAfterFailureRegistersAgainAndSucceeds() async throws {
        let store = FakeStore(nil)
        let registrar = ScriptedRegistrar([
            .failure(RegistrationError(message: "offline")),
            .success("tok-B"),
        ])
        let id = DeviceRegistration(kind: "watch", store: store, registrar: registrar)

        do {
            _ = try await id.token()
            XCTFail("expected the first registration to fail")
        } catch {
            XCTAssertEqual(error as? RegistrationError, RegistrationError(message: "offline"))
        }
        XCTAssertNil(store.written)

        let t = try await id.token()

        XCTAssertEqual(t, "tok-B")
        XCTAssertEqual(store.written, "tok-B")
        XCTAssertEqual(registrar.calls, 2)
    }
}
