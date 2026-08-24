import Foundation
import Network

/// Runs the sidecar's WebSocket server: one `TranscriberSession` per
/// connection, speaking protocol v2 (see the design doc's "Sidecar protocol"
/// section). Listens on 127.0.0.1 only.
///
/// Protocol v2, per connection:
/// - Optional FIRST text frame `{"config":{"locale":...,"format":...}}`
///   selects locale/format (both keys optional; `format` is `pcm16k` |
///   `mulaw8k`). A binary first frame means defaults (en-US / pcm16k).
///   Query parameters are NOT part of the protocol: Network.framework's
///   WebSocket server (`NWProtocolWebSocket.Options.setClientRequestHandler`
///   and the underlying `nw_ws_request_t` C API) never exposes the client's
///   request line, path, or query string, so config rides in-band instead.
/// - Binary frames are audio for `session.feed`.
/// - Text frame `{"finish":true}` ends input WITHOUT closing the socket:
///   the server finalizes the session, flushes every remaining transcript
///   event, sends `{"done":true}`, and then the SERVER closes. Clients must
///   not signal end-of-input by closing — NWProtocolWebSocket tears down the
///   write path the moment an inbound close frame is delivered (all further
///   sends fail ENOTCONN), so nothing sent after a peer close can arrive.
/// - A client that disconnects without `{"finish":true}` gets no final; the
///   session is just torn down (`finish()` still runs exactly once so the
///   analyzer shuts down cleanly; its 10 s watchdog bounds that).
/// - A config frame after audio has started is a protocol error:
///   `{"error":"config after audio"}`, then the server closes.
enum WebSocketServer {
    /// Locale whose model the server ensures at startup (the default for
    /// sessions whose config doesn't name one). A config frame naming a
    /// different locale triggers `ensureModel` for it at session start.
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
        // Accept every handshake; per-connection config arrives in-band (see
        // the type-level note on why it can't come from the request URL).
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

    /// How a connection's receive phase ended.
    private enum Outcome {
        /// Client sent `{"finish":true}`: finalize, flush, `{"done":true}`,
        /// then the server closes.
        case finished
        /// Client closed/dropped, a receive error occurred, or a protocol
        /// error was already answered with `{"error":...}` + close: tear the
        /// session down, no final delivery.
        case teardown
    }

    /// Owns one connection end to end. The session is created lazily from
    /// the first frame (config text frame, or binary/finish implying
    /// defaults); its events are pumped out as JSON text frames by a
    /// forwarder task; `session.finish()` runs exactly once, on this
    /// function's single exit path, whatever ended the receive phase.
    private static func handleConnection(_ connection: NWConnection) async {
        connection.start(queue: queue)
        FileHandle.standardError.write(Data("transcriber: connection open\n".utf8))

        var session: TranscriberSession?
        // Forwards session.events -> JSON text frames until the stream
        // completes; yields whether an `.error` event was seen so the exit
        // path knows the connection was already cancelled.
        var forwarder: Task<Bool, Never>?

        /// Creates the session + forwarder. On failure sends `{"error":...}`
        /// and closes; returns whether the session is usable.
        func startSession(locale: Locale, format: WireFormat) async -> Bool {
            do {
                if locale.identifier != defaultLocale.identifier {
                    try await TranscriberSession.ensureModel(locale: locale)
                }
                let newSession = try await TranscriberSession(locale: locale, format: format)
                session = newSession
                forwarder = Task<Bool, Never> {
                    var sawError = false
                    for await event in newSession.events {
                        switch event {
                        case .ready:
                            await sendJSON(["ready": true], on: connection)
                        case .transcript(let text, let isFinal):
                            await sendJSON(["text": text, "isFinal": isFinal], on: connection)
                        case .error(let message):
                            sawError = true
                            await sendJSON(["error": message], on: connection)
                            // Don't wait around for more audio/finalization
                            // once the session has errored: unblock the
                            // receive loop's pending receive now so finish()
                            // runs and the connection winds down promptly.
                            connection.cancel()
                        }
                    }
                    return sawError
                }
                return true
            } catch {
                await sendJSON(["error": "\(error)"], on: connection)
                await closeGracefully(connection)
                return false
            }
        }

        var outcome = Outcome.teardown
        receive: while true {
            let (content, context, isComplete, error) = await withCheckedContinuation {
                (continuation: CheckedContinuation<(Data?, NWConnection.ContentContext?, Bool, NWError?), Never>) in
                connection.receiveMessage { content, context, isComplete, error in
                    continuation.resume(returning: (content, context, isComplete, error))
                }
            }
            if let error {
                FileHandle.standardError.write(Data("transcriber: receive ended: \(error)\n".utf8))
                break receive
            }
            let opcode = (context?.protocolMetadata(definition: NWProtocolWebSocket.definition)
                as? NWProtocolWebSocket.Metadata)?.opcode
            switch opcode {
            case .close:
                break receive
            case .binary:
                guard let content, !content.isEmpty else { break }
                if session == nil {
                    // Binary first frame: defaults apply.
                    guard await startSession(locale: defaultLocale, format: defaultFormat) else {
                        break receive
                    }
                }
                session?.feed(content)
            case .text:
                guard let content,
                      let object = (try? JSONSerialization.jsonObject(with: content)) as? [String: Any]
                else {
                    await sendJSON(["error": "malformed text frame"], on: connection)
                    await closeGracefully(connection)
                    break receive
                }
                if let config = object["config"] {
                    guard session == nil else {
                        await sendJSON(["error": "config after audio"], on: connection)
                        await closeGracefully(connection)
                        break receive
                    }
                    guard let (locale, format) = parseConfig(config) else {
                        await sendJSON(["error": "bad config"], on: connection)
                        await closeGracefully(connection)
                        break receive
                    }
                    guard await startSession(locale: locale, format: format) else {
                        break receive
                    }
                } else if object["finish"] as? Bool == true {
                    if session == nil {
                        // finish with no audio: still deliver ready + done so
                        // the client's wait terminates deterministically.
                        guard await startSession(locale: defaultLocale, format: defaultFormat) else {
                            break receive
                        }
                    }
                    outcome = .finished
                    break receive
                } else {
                    FileHandle.standardError.write(
                        Data("transcriber: ignoring unrecognized text frame\n".utf8))
                }
            default:
                if content == nil, isComplete {
                    break receive
                }
            }
        }

        if let session {
            if outcome == .teardown {
                // No final delivery on this path (the peer is gone or the
                // error/close frame is already out); cancel now so any
                // forwarder sends fail fast instead of queueing.
                connection.cancel()
            }
            // Exactly one finish() call for this session, on this single
            // path, regardless of how the receive phase ended. finish()
            // flushes every remaining transcript through `events` (the
            // forwarder sends them) and has its own 10 s watchdog.
            await session.finish()
            let sawError = await forwarder?.value ?? false
            if outcome == .finished, !sawError {
                await sendJSON(["done": true], on: connection)
                await closeGracefully(connection)
            }
        } else {
            connection.cancel()
        }
        FileHandle.standardError.write(Data("transcriber: connection closed\n".utf8))
    }

    /// Validates a `{"config":...}` payload. Both keys optional; a
    /// non-object payload, a non-string/empty `locale`, or an unknown
    /// `format` value is rejected (unknown extra keys are ignored).
    private static func parseConfig(_ payload: Any) -> (Locale, WireFormat)? {
        guard let dict = payload as? [String: Any] else { return nil }
        var locale = defaultLocale
        var format = defaultFormat
        if let rawLocale = dict["locale"] {
            guard let identifier = rawLocale as? String, !identifier.isEmpty else { return nil }
            locale = Locale(identifier: identifier)
        }
        if let rawFormat = dict["format"] {
            guard let name = rawFormat as? String, let parsed = WireFormat(rawValue: name) else {
                return nil
            }
            format = parsed
        }
        return (locale, format)
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
    /// connection.
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
