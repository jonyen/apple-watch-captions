import Foundation
import Network

/// Whether this watch currently has *any* network path — Wi‑Fi or cellular,
/// it does not matter which. Feeds `AppModel`'s per-session probe: with
/// neither the phone reachable over `WatchConnectivity` nor a network path
/// here, a session cannot reach any remote transcriber, so it falls back to
/// the on-device path automatically (see `AppModel.start()`).
///
/// Started once at launch and held for the app's lifetime — `NWPathMonitor`
/// is meant to be a long-lived observer, not something created per check.
///
/// Threading: `NWPathMonitor`'s update handler fires on `queue`, off the main
/// actor. `hasNetworkPath` is read synchronously from the main actor (the
/// probe in `AppModel.start()`/`retry()` cannot `await` a path update without
/// changing those call sites' shape), so the flag is written under `lock` and
/// read through it too, rather than published only through `@MainActor`.
final class NetworkReachability {
    /// Seeded `true` — optimistic — rather than `false`: `NWPathMonitor`
    /// delivers its first update asynchronously, sometimes tens of
    /// milliseconds after `start()`. A cold launch with real connectivity
    /// must not read `false` in that window and misroute a session to
    /// on-device merely because the first path update hasn't landed yet.
    private let lock = NSLock()
    private var _hasNetworkPath = true

    /// Synchronously readable from any thread; the probe in `AppModel` reads
    /// it from the main actor without an `await`.
    var hasNetworkPath: Bool {
        lock.lock(); defer { lock.unlock() }
        return _hasNetworkPath
    }

    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "com.jonyen.watchcaptions.reachability")

    /// Begins observing. Call once, at app launch, before any session's
    /// probe reads `hasNetworkPath` — the same reasoning `WCActivation`
    /// documents for activating `WCSession` early.
    func start() {
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            self.lock.lock()
            self._hasNetworkPath = path.status == .satisfied
            self.lock.unlock()
        }
        monitor.start(queue: queue)
    }
}
