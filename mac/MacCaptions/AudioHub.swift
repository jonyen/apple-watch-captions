import Foundation
import CaptionCore

/// Shares one capture pipeline among several caption sessions (compare mode
/// runs one session per provider, but the mic/system audio can only be
/// captured once). Each session gets its own `AudioCapturing` tap; the
/// underlying capture starts with the first tap and stops with the last.
final class AudioHub {
    private let capture: AudioCapturing
    private let lock = NSLock()
    private var sinks: [UUID: (Data) -> Void] = [:]
    private var started = false

    init(capture: AudioCapturing) {
        self.capture = capture
    }

    func makeTap() -> AudioCapturing {
        Tap(hub: self)
    }

    private func add(_ id: UUID, sink: @escaping (Data) -> Void) throws {
        lock.lock()
        sinks[id] = sink
        let needsStart = !started
        started = true
        lock.unlock()
        guard needsStart else { return }
        do {
            try capture.start { [weak self] data in self?.broadcast(data) }
        } catch {
            lock.lock()
            sinks[id] = nil
            started = false
            lock.unlock()
            throw error
        }
    }

    private func remove(_ id: UUID) {
        lock.lock()
        sinks[id] = nil
        let stopNow = started && sinks.isEmpty
        if stopNow { started = false }
        lock.unlock()
        if stopNow { capture.stop() }
    }

    private func broadcast(_ data: Data) {
        lock.lock()
        let sinks = Array(self.sinks.values)
        lock.unlock()
        for sink in sinks { sink(data) }
    }

    private final class Tap: AudioCapturing {
        private let id = UUID()
        private let hub: AudioHub

        init(hub: AudioHub) {
            self.hub = hub
        }

        func start(onChunk: @escaping (Data) -> Void) throws {
            try hub.add(id, sink: onChunk)
        }

        func stop() {
            hub.remove(id)
        }
    }
}
