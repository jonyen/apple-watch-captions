import Foundation

/// Where a device's bearer token lives between launches. The Keychain
/// implementation is supplied by the app; this package only depends on the
/// shape, so registration logic can be tested without touching it.
public protocol SecureTokenStore {
    func read() -> String?
    func write(_ token: String)
    /// Forget the stored token, so the next `token()` registers afresh.
    func clear()
}

/// Registers this device with the relay's one unauthenticated write,
/// `POST /v1/devices`, and hands back the bearer token it issues. The real
/// implementation is supplied by the app; faked in tests so registration
/// logic never makes a network call.
///
/// `Sendable` so `DeviceRegistration` can hand a call off to an unstructured
/// `Task` — the coalescing that keeps two racing first calls from each
/// starting their own registration.
public protocol DeviceRegistrar: Sendable {
    func register(kind: String) async throws -> String
}

/// A device's bearer token: read from the store if one was already issued,
/// otherwise registered once and persisted.
///
/// An actor rather than a class because `token()` can be called concurrently
/// before the first registration completes — at launch, from more than one
/// call site — and registering twice would mint a second device that the
/// relay has no way to reconcile with the first.
///
/// Actor isolation alone is not enough: `register(kind:)` suspends, and an
/// actor is reentrant across a suspension, so a naive "check the store, then
/// await the registrar" body would let a second call see the same empty
/// store while the first is still in flight and register a second time. The
/// fix is to coalesce onto a single in-flight `Task`: the first caller starts
/// it, subsequent callers that arrive before it finishes await that same
/// task instead of starting their own, and only the caller that started it
/// persists the result.
///
/// `cached` is an in-memory memo on top of that, not a substitute for it:
/// without it, every `token()` call re-reads the store (a Keychain XPC round
/// trip on the real implementation), including calls from a 1 Hz-or-faster
/// poll loop. Worse than the latency: if the store can never persist — an
/// un-granted Keychain access group returns `errSecMissingEntitlement` and
/// silently no-ops the write — every call with no memo takes the
/// registration branch forever, minting a fresh device on the relay several
/// times a second for the life of the process. The memo bounds that failure
/// to one registration per launch. Set only by the call that actually
/// resolved a value (the store-read branch, or the caller that persisted a
/// fresh registration) — a concurrent caller coalescing onto that
/// registration's `Task` gets the same string back without needing to touch
/// `cached` itself.
public actor DeviceRegistration {
    private let kind: String
    private let store: SecureTokenStore
    private let registrar: DeviceRegistrar
    private var inFlightRegistration: Task<String, Error>?
    private var cached: String?

    public init(kind: String, store: SecureTokenStore, registrar: DeviceRegistrar) {
        self.kind = kind
        self.store = store
        self.registrar = registrar
    }

    /// The bearer token for this device, registering once on first call if
    /// absent. A registrar failure propagates and leaves the store untouched,
    /// so the next call simply tries again rather than persisting a partial
    /// success.
    public func token() async throws -> String {
        if let cached {
            return cached
        }
        if let stored = store.read() {
            cached = stored
            return stored
        }
        if let inFlightRegistration {
            return try await inFlightRegistration.value
        }

        let registrar = self.registrar
        let kind = self.kind
        let registration = Task { try await registrar.register(kind: kind) }
        inFlightRegistration = registration
        defer { inFlightRegistration = nil }

        let token = try await registration.value
        store.write(token)
        cached = token
        return token
    }

    /// Drops the stored token. Called when the relay answers 401 — the token
    /// was minted against an identity the relay no longer holds (a database
    /// reset, a relay reinstall), and no amount of retrying with it can ever
    /// succeed. The next `token()` call registers this device afresh.
    public func invalidate() {
        cached = nil
        store.clear()
    }
}
