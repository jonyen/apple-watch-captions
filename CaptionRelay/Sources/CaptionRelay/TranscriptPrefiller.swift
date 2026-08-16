import Foundation
import CaptionCore

/// Restores a resumed transcript's scrollback behind a running session.
///
/// Deliberately not awaited by callers: the captions screen appears at once
/// and the history fills in behind it. A failure is dropped — an error banner
/// over a working session would be worse than missing scrollback.
@MainActor
public final class TranscriptPrefiller {
    private let history: HistoryClient
    /// Retained so tests can await the restore. The app never waits on it.
    private var task: Task<Void, Never>?
    /// The restore a newer one superseded. Tests only, like the original.
    private var supersededTask: Task<Void, Never>?

    public init(history: HistoryClient) {
        self.history = history
    }

    /// Put `name`'s transcript back in `controller`'s store — unless that
    /// session has ended by the time the fetch returns. The token captured
    /// here is the same guard the controller uses internally: `cancel()` is
    /// only a best-effort request, so a fetch already in flight can complete
    /// after its session ended, and `isRunning` alone cannot tell that
    /// session apart from a later one.
    public func restore(name: String, into store: CaptionStore,
                        for controller: SessionController) {
        supersededTask = task
        let token = controller.sessionToken
        task = Task { [weak controller] in
            guard let segments = try? await history.detail(name: name).segments else { return }
            guard let controller, controller.isRunning,
                  controller.sessionToken == token else { return }
            store.prepend(segments)
        }
    }

    public func cancel() {
        task?.cancel()
        task = nil
    }

    /// Awaits the current restore and one a later `restore` superseded.
    /// Tests only — production never waits on either.
    func waitForRestore() async {
        await supersededTask?.value
        await task?.value
    }
}
