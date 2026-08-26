import Foundation
import TranscriberCore

let args = CommandLine.arguments
if let i = args.firstIndex(of: "--file"), i + 1 < args.count {
    let url = URL(fileURLWithPath: args[i + 1])
    do {
        let locale = Locale(identifier: "en-US")
        try await TranscriberSession.ensureModel(locale: locale)
        let session = try await TranscriberSession(locale: locale, format: .pcm16k)
        let consume = Task {
            for await event in session.events {
                switch event {
                case .ready:
                    FileHandle.standardError.write(Data("ready\n".utf8))
                case .transcript(let text, let isFinal):
                    print(isFinal ? "FINAL: \(text)" : "partial: \(text)")
                case .error(let message):
                    FileHandle.standardError.write(Data("error: \(message)\n".utf8))
                }
            }
        }
        let wav = try Data(contentsOf: url)
        guard let payload = wavDataChunk(wav) else {
            FileHandle.standardError.write(Data("failed: not a RIFF/WAVE file or no data chunk\n".utf8))
            exit(1)
        }
        // Feed in 100 ms chunks at ~5x real time so volatile results stream
        // like they will from the live wire.
        let chunkBytes = 3200  // 100 ms of 16-bit mono @ 16 kHz
        var offset = 0
        while offset < payload.count {
            let end = min(offset + chunkBytes, payload.count)
            session.feed(payload.subdata(in: offset..<end))
            offset = end
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        await session.finish()
        await consume.value
    } catch {
        FileHandle.standardError.write(Data("failed: \(error)\n".utf8))
        exit(1)
    }
    exit(0)
}

// Server mode is the default (no args): WebSocket server on 127.0.0.1;
// PORT env overrides the port.
let port: UInt16 = {
    if let raw = ProcessInfo.processInfo.environment["PORT"], let value = UInt16(raw) {
        return value
    }
    return 8790
}()
do {
    try await WebSocketServer.run(port: port)
} catch {
    FileHandle.standardError.write(Data("transcriber: server failed: \(error)\n".utf8))
    exit(1)
}
