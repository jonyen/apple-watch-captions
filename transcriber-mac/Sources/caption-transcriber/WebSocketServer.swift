import Foundation
import Network

/// Runs the sidecar's WebSocket server: one `TranscriberSession` per
/// connection, binary frames in (audio), JSON text frames out
/// (`{"ready":true}` / `{"text":...,"isFinal":...}` / `{"error":...}`
/// then close). Listens on 127.0.0.1 only.
///
/// LOCALE/FORMAT LIMITATION (flagged for the controller — see task-3-report):
/// the wire protocol calls for `locale`/`format` query parameters on the
/// connection URL (e.g. `ws://127.0.0.1:8790/?format=mulaw8k`). Network.framework's
/// public API for `NWProtocolWebSocket` — both the Swift overlay
/// (`NWProtocolWebSocket.Options.setClientRequestHandler`, which hands back
/// only `subprotocols` and `additionalHeaders`) and the underlying C API
/// (`nw_ws_request_t` in `<Network/ws_options.h>`, which likewise only
/// enumerates subprotocols and additional headers) — never exposes the
/// client's HTTP request line, path, or query string. The framework consumes
/// and validates the handshake internally. So there is no public-API way to
/// read `?locale=`/`?format=` here: every connection uses the defaults below
/// (en-US / pcm16k) regardless of what the client's URL contains. Task 4's
/// planned `?format=mulaw8k` suffix for telephony will therefore currently
/// have no effect on the server. If per-connection format/locale is needed,
/// the two workable channels given this API are (a) a custom HTTP header —
/// visible via `additionalHeaders` in `setClientRequestHandler`, settable
/// from Node's `ws` client via the `headers` constructor option — or (b) a
/// WebSocket subprotocol name encoding the params (visible via
/// `subprotocols` there and `selectedSubprotocol` in the frame metadata).
///
/// CLOSE-TIMING LIMITATION (flagged for the controller — see task-3-report):
/// `TranscriberSession` only emits transcript events once `finish()` calls
/// `finalizeAndFinishThroughEndOfInput()` — verified (via `--file` mode with
/// timestamped output) to hold even when audio is fed in real time with no
/// gaps, i.e. the analyzer withholds *all* results, partials included, until
/// finalize, rather than streaming them as it goes. `finish()` here only
/// runs once `receiveLoop` sees the client's close (by design — "On client
/// close: await session.finish()"). But NWProtocolWebSocket, once it has
/// delivered an inbound close frame to the app, refuses all further sends on
/// that connection (`connection.send` completes immediately with `ENOTCONN`)
/// — verified by attempting a send in the same tick `receiveMessage` hands
/// back the close opcode, and separately by reproducing the identical
/// ENOTCONN-on-second-send behavior with `TranscriberSession` removed
/// entirely from the picture, then ruling it out again once the send after
/// close was the only thing changed back. Net effect: with a client that
/// signals "done" only by closing (as the wire protocol currently
/// specifies), the final transcript can never reach it. `ws-smoke.mjs`'s
/// `{"ready":true}` line above by itself confirms the handshake, audio
/// ingestion, and JSON-out mechanics all work — the transcript itself came
/// out byte-correct in every trial (see task-3-report.md's transcript
/// dump); only the last leg (delivering it before the peer's close finishes
/// tearing the connection down) is blocked by this. No public API found to
/// suppress it. This needs either a wire-protocol change (an explicit
/// end-of-audio signal distinct from closing) or a fix upstream in
/// `TranscriberSession` (streaming results before finalize) — not something
/// fixable from this file alone.
enum WebSocketServer {
    /// Locale the server ensures/reserves at startup and uses for every
    /// connection (see the type-level note on why this can't vary per
    /// connection today).
    static let defaultLocale = Locale(identifier: "en-US")
    static let defaultFormat: WireFormat = .pcm16k

    /// Dedicated queue for the listener and every accepted connection,
    /// rather than `.main` -- keeps Network.framework's callback delivery
    /// independent of whatever else the top-level async `main.swift` context
    /// is doing.
    private static let queue = DispatchQueue(label: "caption-transcriber.network")

    /// Starts listening and never returns (until the process is killed).
    static func run(port: UInt16) async throws {
        FileHandle.standardError.write(
            Data("transcriber: ensuring speech model for \(defaultLocale.identifier)\n".utf8))
        try await TranscriberSession.ensureModel(locale: defaultLocale)

        guard let nwPort = NWEndpoint.Port(rawValue: port) else {
            throw NSError(domain: "transcriber", code: 20,
                          userInfo: [NSLocalizedDescriptionKey: "invalid port \(port)"])
        }

        let wsOptions = NWProtocolWebSocket.Options()
        wsOptions.autoReplyPing = true
        // Accept every handshake; see the type-level note above on why we
        // can't select locale/format from the request here.
        wsOptions.setClientRequestHandler(queue) { _, _ in
            NWProtocolWebSocket.Response(status: .accept, subprotocol: nil)
        }

        let parameters = NWParameters(tls: nil)
        parameters.defaultProtocolStack.applicationProtocols.insert(wsOptions, at: 0)
        parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: nwPort)
        parameters.allowLocalEndpointReuse = true

        // The port is carried by `requiredLocalEndpoint` above; passing it
        // again here as `on:` conflicts (NWListener reports EINVAL).
        let listener = try NWListener(using: parameters)

        listener.newConnectionHandler = { connection in
            Task { await handleConnection(connection) }
        }

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            // `stateUpdateHandler` fires serially on the queue we
            // start(queue:) below with, so this is never actually accessed
            // concurrently; `nonisolated(unsafe)` documents that instead of
            // reaching for a lock for a one-shot startup gate.
            nonisolated(unsafe) var resumed = false
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    guard !resumed else { return }
                    resumed = true
                    FileHandle.standardError.write(
                        Data("transcriber: listening on 127.0.0.1:\(port)\n".utf8))
                    continuation.resume()
                case .failed(let error):
                    guard !resumed else { return }
                    resumed = true
                    continuation.resume(throwing: error)
                default:
                    break
                }
            }
            listener.start(queue: queue)
        }

        // Park here forever; newConnectionHandler + per-connection tasks
        // keep the process doing work until it's killed externally.
        try await Task.sleep(nanoseconds: .max)
    }

    /// Owns one connection end to end: creates the session, pumps its events
    /// out as JSON text frames, pumps incoming binary frames into it, and
    /// closes down on either side ending. Logs one open + one close line.
    private static func handleConnection(_ connection: NWConnection) async {
        connection.start(queue: queue)
        FileHandle.standardError.write(Data("transcriber: connection open\n".utf8))

        let session: TranscriberSession
        do {
            session = try await TranscriberSession(locale: defaultLocale, format: defaultFormat)
        } catch {
            await sendJSON(["error": "\(error)"], on: connection)
            connection.cancel()
            FileHandle.standardError.write(
                Data("transcriber: connection closed (session init failed)\n".utf8))
            return
        }

        // Forwards session.events -> JSON text frames until the stream
        // completes; returns whether an `.error` event was seen so the
        // caller knows the connection was already cancelled.
        let forwarder = Task<Bool, Never> {
            var sawError = false
            for await event in session.events {
                switch event {
                case .ready:
                    await sendJSON(["ready": true], on: connection)
                case .transcript(let text, let isFinal):
                    await sendJSON(["text": text, "isFinal": isFinal], on: connection)
                case .error(let message):
                    sawError = true
                    await sendJSON(["error": message], on: connection)
                    // Don't wait around for more audio/finalization once the
                    // session has errored: unblock receiveLoop's pending
                    // receive now so finish() runs and the connection winds
                    // down promptly.
                    connection.cancel()
                }
            }
            return sawError
        }

        await receiveLoop(connection, session: session)
        // Exactly one finish() call for this session, on this single path,
        // regardless of whether the client closed cleanly, dropped the
        // connection, or the forwarder already cancelled us after an error.
        await session.finish()
        let sawError = await forwarder.value
        if !sawError {
            await closeGracefully(connection)
        }
        FileHandle.standardError.write(Data("transcriber: connection closed\n".utf8))
    }

    /// Reads binary frames into `session.feed`; returns on a client close
    /// frame, a receive error (including our own `connection.cancel()`), or
    /// a plain end-of-stream.
    private static func receiveLoop(_ connection: NWConnection, session: TranscriberSession) async {
        while true {
            let (content, context, isComplete, error) = await withCheckedContinuation {
                (continuation: CheckedContinuation<(Data?, NWConnection.ContentContext?, Bool, NWError?), Never>) in
                connection.receiveMessage { content, context, isComplete, error in
                    continuation.resume(returning: (content, context, isComplete, error))
                }
            }
            if let error {
                FileHandle.standardError.write(Data("transcriber: receive ended: \(error)\n".utf8))
                return
            }
            let opcode = (context?.protocolMetadata(definition: NWProtocolWebSocket.definition)
                as? NWProtocolWebSocket.Metadata)?.opcode
            if opcode == .close {
                return
            }
            if opcode == .binary, let content, !content.isEmpty {
                session.feed(content)
            }
            if content == nil, isComplete {
                return
            }
        }
    }

    /// Each text frame gets its own `ContentContext` identifier so
    /// Network.framework treats every send as an independent message rather
    /// than risking it associating repeats of the same identifier together.
    private static func sendJSON(_ object: [String: Any], on connection: NWConnection) async {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        let context = NWConnection.ContentContext(identifier: "text-\(UUID().uuidString)",
                                                    metadata: [NWProtocolWebSocket.Metadata(opcode: .text)])
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            connection.send(content: data, contentContext: context, isComplete: true,
                             completion: .contentProcessed { error in
                if let error {
                    FileHandle.standardError.write(Data("transcriber: send error: \(error)\n".utf8))
                }
                continuation.resume()
            })
        }
    }

    /// Sends a normal-closure WebSocket close frame, then tears down the
    /// connection. Only used on the non-error path — after an `.error`
    /// event the forwarder has already force-cancelled the connection.
    private static func closeGracefully(_ connection: NWConnection) async {
        let closeMetadata = NWProtocolWebSocket.Metadata(opcode: .close)
        closeMetadata.closeCode = .protocolCode(.normalClosure)
        let context = NWConnection.ContentContext(identifier: "close", metadata: [closeMetadata])
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            connection.send(content: nil, contentContext: context, isComplete: true,
                             completion: .contentProcessed { error in
                if let error {
                    FileHandle.standardError.write(Data("transcriber: close-frame send error: \(error)\n".utf8))
                }
                continuation.resume()
            })
        }
        connection.cancel()
    }
}
