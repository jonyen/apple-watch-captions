import Foundation

/// TEMPORARY diagnostic breadcrumb file, pullable off the watch with
/// `devicectl device copy from ... --source Documents/debug-trail.txt`.
/// Console streaming does not work from a wirelessly paired watch, so this
/// file is the only reliable way to see why a relay session failed on
/// hardware. Remove once the connection-lost investigation closes.
enum DebugTrail {
    private static let queue = DispatchQueue(label: "debug-trail")
    private static let url: URL = {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        try? FileManager.default.createDirectory(at: docs, withIntermediateDirectories: true)
        return docs.appendingPathComponent("debug-trail.txt")
    }()

    static func log(_ line: String) {
        queue.async {
            let stamp = ISO8601DateFormatter().string(from: Date())
            let entry = "\(stamp) \(line)\n"
            if let handle = try? FileHandle(forWritingTo: url) {
                handle.seekToEndOfFile()
                handle.write(Data(entry.utf8))
                try? handle.close()
            } else {
                try? entry.write(to: url, atomically: true, encoding: .utf8)
            }
        }
    }
}
