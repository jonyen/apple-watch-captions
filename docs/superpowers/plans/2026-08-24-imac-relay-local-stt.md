# iMac relay with local speech-to-text Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the caption relay on the iMac (`ring`) with Apple SpeechTranscriber doing the transcription locally, replacing Fly.io + Deepgram.

**Architecture:** A Swift sidecar (`transcriber-mac/`) wraps macOS 26's SpeechAnalyzer/SpeechTranscriber behind a localhost WebSocket speaking binary PCM in / JSON transcripts out. A new `AppleTranscriptionProvider` in the Node backend implements the existing `TranscriptionProvider` interface over that socket. Both run on `ring` under launchd, exposed through Tailscale Funnel; the watch and iPhone apps point their `relayURL` at the funnel host.

**Tech Stack:** Swift 6 (Network.framework NWListener WebSocket, Speech, AVFAudio), Node 22 backend (`ws`), launchd, Tailscale Funnel, Doppler.

**Spec:** `docs/superpowers/specs/2026-08-24-imac-relay-local-stt-design.md`

## Global Constraints

- Sidecar protocol exactly as the spec defines it: binary frames = audio in; text frames = one JSON object each of `{"ready":true}`, `{"text":...,"isFinal":bool}`, `{"error":"..."}`; query params `locale` (default `en-US`) and `format` = `pcm16k` (default) | `mulaw8k`; listen address `127.0.0.1:8790`, `PORT` env overrides.
- Provider name is `"apple"`; env `APPLE_TRANSCRIBER_URL` default `ws://127.0.0.1:8790`.
- `backend/` changes must keep every existing test green (`npm test` in backend/). No change to `watch/`, `ios/`, `CaptionRelay/` except the Secrets URL swap in Task 7.
- The working tree holds unrelated untracked files (`mac/`, `watch/CaptionCore/`, `*.prod-backup`) — commit only files each task names.
- launchd labels: `com.jonyen.caption-transcriber`, `com.jonyen.caption-relay`; installed as user LaunchAgents on `ring` (`~/Library/LaunchAgents`).
- Commits: normal prose, conventional prefix, trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- `ring` is reachable as `ssh ring` (user jonyen). Never run destructive commands against the Fly app; cutover leaves Fly running until the user retires it.

---

## File map

| Path | Change |
|---|---|
| `transcriber-mac/Package.swift` | new Swift package, macOS 26, executable `caption-transcriber` |
| `transcriber-mac/Sources/caption-transcriber/PCMDecoder.swift` | s16le + µ-law bytes → `AVAudioPCMBuffer` |
| `transcriber-mac/Sources/caption-transcriber/TranscriberSession.swift` | SpeechAnalyzer/SpeechTranscriber wrapper |
| `transcriber-mac/Sources/caption-transcriber/WebSocketServer.swift` | NWListener WS server, one session per connection |
| `transcriber-mac/Sources/caption-transcriber/main.swift` | arg parsing, `--file` smoke mode, server mode |
| `transcriber-mac/Tests/…/PCMDecoderTests.swift` | unit tests |
| `transcriber-mac/scripts/ws-smoke.mjs` | integration: stream a wav over WS, print events |
| `backend/src/appleProvider.ts` + `.test.ts` | the provider |
| `backend/src/providerOptions.ts` | add `"apple"` |
| `backend/src/serverOptions.ts` / `config.ts` | env wiring (whichever holds provider construction — Task 4 discovers) |
| `deploy/ring/*.plist`, `deploy/ring/README.md` | launchd + deployment docs |
| `watch/WatchCaptions/Secrets.swift`, `ios/Shared/Secrets.swift` | URL swap (cutover; not committed — secrets are untracked) |

---

### Task 1: Sidecar package and PCM decoding

**Files:**
- Create: `transcriber-mac/Package.swift`, `transcriber-mac/Sources/caption-transcriber/PCMDecoder.swift`, `transcriber-mac/Sources/caption-transcriber/main.swift` (stub that prints usage)
- Test: `transcriber-mac/Tests/CaptionTranscriberTests/PCMDecoderTests.swift`

**Interfaces:**
- Produces: `enum WireFormat { case pcm16k, mulaw8k }`, `struct PCMDecoder { init(format: WireFormat); func buffer(from data: Data) -> AVAudioPCMBuffer? ; var sourceFormat: AVAudioFormat }`. `buffer(from:)` wraps raw bytes into a PCM buffer in the wire's native format (s16le 16 kHz mono, or µ-law decoded to s16le 8 kHz mono); resampling to the analyzer's preferred format happens later via `AVAudioConverter` in Task 2.

- [ ] **Step 1: Package.swift**

```swift
// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "caption-transcriber",
    platforms: [.macOS("26.0")],
    targets: [
        .executableTarget(name: "caption-transcriber", path: "Sources/caption-transcriber"),
        .testTarget(name: "CaptionTranscriberTests",
                    dependencies: ["caption-transcriber"],
                    path: "Tests/CaptionTranscriberTests"),
    ],
    swiftLanguageModes: [.v5]
)
```

`main.swift` stub: `print("caption-transcriber: use --file <wav> or server mode (Task 3)")`.

- [ ] **Step 2: Failing tests**

```swift
import XCTest
@testable import caption_transcriber

final class PCMDecoderTests: XCTestCase {
    func testPCM16kWrapsSamplesLosslessly() {
        let d = PCMDecoder(format: .pcm16k)
        let samples: [Int16] = [0, 1000, -1000, Int16.max, Int16.min]
        let data = samples.withUnsafeBytes { Data($0) }
        let buf = d.buffer(from: data)!
        XCTAssertEqual(buf.format.sampleRate, 16_000)
        XCTAssertEqual(buf.frameLength, 5)
        let out = UnsafeBufferPointer(start: buf.int16ChannelData![0], count: 5)
        XCTAssertEqual(Array(out), samples)
    }

    func testMulawDecodesKnownBytes() {
        let d = PCMDecoder(format: .mulaw8k)
        // 0xFF is µ-law for 0; 0x7F is µ-law for the most negative value region.
        let buf = d.buffer(from: Data([0xFF, 0xFF]))!
        XCTAssertEqual(buf.format.sampleRate, 8_000)
        XCTAssertEqual(buf.frameLength, 2)
        let out = UnsafeBufferPointer(start: buf.int16ChannelData![0], count: 2)
        XCTAssertEqual(out[0], 0)   // µ-law 0xFF decodes to 0
    }

    func testOddByteCountPCMDropsTrailingByte() {
        let d = PCMDecoder(format: .pcm16k)
        let buf = d.buffer(from: Data([0x00, 0x01, 0x02]))!
        XCTAssertEqual(buf.frameLength, 1)
    }
}
```

- [ ] **Step 3: Run, verify FAIL** — `cd transcriber-mac && swift test` fails: PCMDecoder undefined.

- [ ] **Step 4: Implement PCMDecoder**

```swift
import AVFAudio

enum WireFormat: String {
    case pcm16k, mulaw8k
}

/// Wraps raw wire bytes into AVAudioPCMBuffers in the wire's native format.
/// µ-law is decoded to linear Int16 here (the standard G.711 expansion);
/// sample-rate conversion to the analyzer's preferred format is the
/// TranscriberSession's job.
struct PCMDecoder {
    let format: WireFormat
    let sourceFormat: AVAudioFormat

    init(format: WireFormat) {
        self.format = format
        let rate: Double = format == .pcm16k ? 16_000 : 8_000
        sourceFormat = AVAudioFormat(commonFormat: .pcmFormatInt16,
                                     sampleRate: rate, channels: 1, interleaved: true)!
    }

    func buffer(from data: Data) -> AVAudioPCMBuffer? {
        switch format {
        case .pcm16k:
            let frames = data.count / 2
            guard frames > 0,
                  let buf = AVAudioPCMBuffer(pcmFormat: sourceFormat,
                                             frameCapacity: AVAudioFrameCount(frames)) else { return nil }
            buf.frameLength = AVAudioFrameCount(frames)
            data.withUnsafeBytes { raw in
                buf.int16ChannelData![0].update(from: raw.bindMemory(to: Int16.self).baseAddress!,
                                                count: frames)
            }
            return buf
        case .mulaw8k:
            guard !data.isEmpty,
                  let buf = AVAudioPCMBuffer(pcmFormat: sourceFormat,
                                             frameCapacity: AVAudioFrameCount(data.count)) else { return nil }
            buf.frameLength = AVAudioFrameCount(data.count)
            let out = buf.int16ChannelData![0]
            for (i, byte) in data.enumerated() { out[i] = PCMDecoder.mulawToLinear(byte) }
            return buf
        }
    }

    /// G.711 µ-law expansion.
    static func mulawToLinear(_ byte: UInt8) -> Int16 {
        let u = ~byte
        let sign = (u & 0x80) != 0
        let exponent = Int((u >> 4) & 0x07)
        let mantissa = Int(u & 0x0F)
        let magnitude = ((mantissa << 3) + 0x84) << exponent
        let value = magnitude - 0x84
        return Int16(sign ? -value : value)
    }
}
```

- [ ] **Step 5: Run, verify PASS** — `swift test` green. If the µ-law known-value assertion disagrees with the implementation, verify against the G.711 table (0xFF → 0) and fix the code, not the test.

- [ ] **Step 6: Commit** — `git add transcriber-mac && git commit -m "feat(transcriber-mac): sidecar package with PCM and µ-law decoding"`

---

### Task 2: SpeechTranscriber session and --file smoke mode

**Files:**
- Create: `transcriber-mac/Sources/caption-transcriber/TranscriberSession.swift`
- Modify: `transcriber-mac/Sources/caption-transcriber/main.swift`

**Interfaces:**
- Consumes: `PCMDecoder` (Task 1).
- Produces: `actor TranscriberSession { init(locale: Locale, format: WireFormat) async throws; func feed(_ data: Data); func finish() async; var events: AsyncStream<Event> }` with `enum Event { case ready; case transcript(text: String, isFinal: Bool); case error(String) }`. `static func ensureModel(locale: Locale) async throws` (AssetInventory download).

**API references the implementer MUST read first** (the code below is a strong sketch; exact names must be verified to compile): https://developer.apple.com/documentation/speech/speechanalyzer , /speechtranscriber , /assetinventory , and WWDC25 session 277 notes.

- [ ] **Step 1: Implement TranscriberSession**

```swift
import Foundation
import Speech
import AVFAudio

actor TranscriberSession {
    enum Event {
        case ready
        case transcript(text: String, isFinal: Bool)
        case error(String)
    }

    let events: AsyncStream<Event>
    private let eventsIn: AsyncStream<Event>.Continuation
    private let decoder: PCMDecoder
    private let converter: AVAudioConverter
    private let analyzerFormat: AVAudioFormat
    private let analyzer: SpeechAnalyzer
    private let inputBuilder: AsyncStream<AnalyzerInput>.Continuation
    private var resultsTask: Task<Void, Never>?

    static func ensureModel(locale: Locale) async throws {
        let transcriber = SpeechTranscriber(locale: locale, preset: .progressiveLiveTranscription)
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            try await request.downloadAndInstall()
        }
    }

    init(locale: Locale, format: WireFormat) async throws {
        let transcriber = SpeechTranscriber(locale: locale,
                                            transcriptionOptions: [],
                                            reportingOptions: [.volatileResults],
                                            attributeOptions: [])
        guard let best = await SpeechTranscriber.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
            throw NSError(domain: "transcriber", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "no analyzer audio format"])
        }
        analyzerFormat = best
        decoder = PCMDecoder(format: format)
        guard let conv = AVAudioConverter(from: decoder.sourceFormat, to: best) else {
            throw NSError(domain: "transcriber", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "no converter to analyzer format"])
        }
        converter = conv
        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        inputBuilder = continuation
        analyzer = SpeechAnalyzer(modules: [transcriber])
        (events, eventsIn) = AsyncStream<Event>.makeStream()
        try await analyzer.start(inputSequence: stream)

        resultsTask = Task { [eventsIn] in
            do {
                for try await result in transcriber.results {
                    let text = String(result.text.characters)
                    eventsIn.yield(.transcript(text: text, isFinal: result.isFinal))
                }
            } catch {
                eventsIn.yield(.error(String(describing: error)))
            }
        }
        eventsIn.yield(.ready)
    }

    nonisolated func feed(_ data: Data) {
        Task { await self.feedInternal(data) }
    }

    private func feedInternal(_ data: Data) {
        guard let src = decoder.buffer(from: data) else { return }
        let ratio = analyzerFormat.sampleRate / decoder.sourceFormat.sampleRate
        let capacity = AVAudioFrameCount(Double(src.frameLength) * ratio) + 16
        guard let dst = AVAudioPCMBuffer(pcmFormat: analyzerFormat, frameCapacity: capacity) else { return }
        var fed = false
        var error: NSError?
        converter.convert(to: dst, error: &error) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true; status.pointee = .haveData; return src
        }
        if error == nil, dst.frameLength > 0 {
            inputBuilder.yield(AnalyzerInput(buffer: dst))
        }
    }

    func finish() async {
        inputBuilder.finish()
        try? await analyzer.finalizeAndFinishThroughEndOfInput()
        resultsTask?.cancel()
        eventsIn.finish()
    }
}
```

- [ ] **Step 2: --file smoke mode in main.swift**

```swift
import Foundation

let args = CommandLine.arguments
if let i = args.firstIndex(of: "--file"), i + 1 < args.count {
    let url = URL(fileURLWithPath: args[i + 1])
    let sema = DispatchSemaphore(value: 0)
    Task {
        do {
            try await TranscriberSession.ensureModel(locale: Locale(identifier: "en-US"))
            let session = try await TranscriberSession(locale: Locale(identifier: "en-US"), format: .pcm16k)
            let consume = Task {
                for await event in session.events {
                    switch event {
                    case .ready: FileHandle.standardError.write(Data("ready\n".utf8))
                    case .transcript(let text, let isFinal):
                        print(isFinal ? "FINAL: \(text)" : "partial: \(text)")
                    case .error(let message): FileHandle.standardError.write(Data("error: \(message)\n".utf8))
                    }
                }
            }
            // Naive 44-byte-header WAV read is fine for our own 16k mono test clips.
            let wav = try Data(contentsOf: url)
            session.feed(wav.dropFirst(44))
            await session.finish()
            await consume.value
        } catch { FileHandle.standardError.write(Data("failed: \(error)\n".utf8)) }
        sema.signal()
    }
    sema.wait()
    exit(0)
}
print("caption-transcriber: --file <wav> | server (Task 3)")
```

- [ ] **Step 3: Build until it compiles** — `swift build` — fix API-name drift against the docs (this is the expected hard part; the protocol contract, not this file's internals, is what later tasks depend on).

- [ ] **Step 4: Smoke test with a real clip**

```bash
cp ~/Projects/moonshine-coreml/test-assets/hello.wav /tmp/hello.wav
swift run caption-transcriber --file /tmp/hello.wav
```
Expected: a FINAL line whose text matches `~/Projects/moonshine-coreml/test-assets/hello.txt` modulo punctuation/casing. First run may download the speech model (AssetInventory) — allow minutes.

- [ ] **Step 5: Commit** — `git add transcriber-mac && git commit -m "feat(transcriber-mac): SpeechTranscriber session with file smoke mode"`

---

### Task 3: WebSocket server mode

**Files:**
- Create: `transcriber-mac/Sources/caption-transcriber/WebSocketServer.swift`, `transcriber-mac/scripts/ws-smoke.mjs`
- Modify: `transcriber-mac/Sources/caption-transcriber/main.swift` (server is the default mode)

**Interfaces:**
- Consumes: `TranscriberSession` (Task 2), `WireFormat` (Task 1).
- Produces: the spec's wire protocol on `127.0.0.1:8790` (`PORT` env overrides).

- [ ] **Step 1: Implement the server** — `NWListener` with `NWProtocolWebSocket.Options()` layered on TCP, bound to `127.0.0.1`. Per connection: parse `locale`/`format` from the request path (available via the WebSocket metadata's request; default `en-US`/`pcm16k`), create a `TranscriberSession`, pump `session.events` → JSON text frames (`{"ready":true}`, `{"text":,"isFinal":}`, `{"error":}` then close), and binary frames → `session.feed`. On client close: `await session.finish()`. JSON encoding via `JSONSerialization` of `[String: Any]`. Log one line per connection open/close to stderr.

- [ ] **Step 2: ws-smoke.mjs**

```js
// Streams a 16k mono wav to the sidecar like the relay will. Usage:
//   node ws-smoke.mjs ws://127.0.0.1:8790 /tmp/hello.wav
import { readFileSync } from "node:fs";
import WebSocket from "ws";
const [url, wavPath] = process.argv.slice(2);
const pcm = readFileSync(wavPath).subarray(44);
const ws = new WebSocket(url);
ws.on("message", (m) => console.log(String(m)));
ws.on("open", async () => {
  for (let off = 0; off < pcm.length; off += 3200) {   // 100 ms chunks
    ws.send(pcm.subarray(off, off + 3200));
    await new Promise((r) => setTimeout(r, 100));
  }
  setTimeout(() => ws.close(), 2000);
});
ws.on("close", () => process.exit(0));
```

- [ ] **Step 3: End-to-end check** — terminal A: `swift run caption-transcriber`; terminal B: `cd transcriber-mac/scripts && npm init -y >/dev/null && npm i ws >/dev/null && node ws-smoke.mjs ws://127.0.0.1:8790 /tmp/hello.wav`. Expected output: `{"ready":true}` then partial lines then a final whose text matches the clip. (`scripts/node_modules` gets a `.gitignore`.)

- [ ] **Step 4: Commit** — `git add transcriber-mac && git commit -m "feat(transcriber-mac): localhost WebSocket server speaking the sidecar protocol"`

---

### Task 4: AppleTranscriptionProvider in the backend

**Files:**
- Create: `backend/src/appleProvider.ts`, `backend/src/appleProvider.test.ts`
- Modify: `backend/src/providerOptions.ts` (add `"apple"` to `PROVIDER_NAMES`), plus the single place providers are constructed from `ProviderOptions`/env (find it via `grep -rn "DeepgramProvider" backend/src` — wire `provider === "apple"` and `TRANSCRIPTION_PROVIDER=apple` default there, passing `APPLE_TRANSCRIBER_URL ?? "ws://127.0.0.1:8790"` and appending `?format=mulaw8k` when `telephony`).

**Interfaces:**
- Consumes: `TranscriptionProvider`, `Transcript` from `./transcriptionProvider`; `ws` package (already a dependency).
- Produces: `class AppleTranscriptionProvider implements TranscriptionProvider { constructor(url: string, wsFactory?: (url: string) => WebSocketLike) }` — the factory injection mirrors `DeepgramLike` and keeps tests socket-free.

- [ ] **Step 1: Failing tests** — model on `deepgramProvider.test.ts`'s style (read it first). Cover: audio sent before the socket opens is buffered and flushed on open; `{"ready":true}` fires `onReady`; `{"text":"a","isFinal":false}` and final variants map to `onTranscript` with the right `isFinal`; `{"error":"x"}` fires `onError`; unexpected socket close after ready fires `onError("transcriber connection lost")`; `close()` closes the socket without an error event; malformed JSON frames are ignored.

- [ ] **Step 2: Run, verify FAIL** — `cd backend && npm test -- appleProvider`.

- [ ] **Step 3: Implement**

```ts
import WebSocket from "ws";
import { TranscriptionProvider, Transcript } from "./transcriptionProvider";

export interface WebSocketLike {
  on(event: string, cb: (...args: any[]) => void): unknown;
  send(data: Buffer): void;
  close(): void;
  readyState: number;
}

export const APPLE_DEFAULT_URL = "ws://127.0.0.1:8790";

/**
 * Provider backed by the caption-transcriber sidecar (Apple SpeechTranscriber
 * on the same machine). The sidecar is local and does not drop connections
 * the way Deepgram's cloud sockets do, so there is no reconnect machinery:
 * an unexpected close is a real failure and is surfaced as one.
 */
export class AppleTranscriptionProvider implements TranscriptionProvider {
  private ws: WebSocketLike;
  private opened = false;
  private closed = false;
  private pending: Buffer[] = [];
  private transcriptHandler: (t: Transcript) => void = () => {};
  private readyHandler: () => void = () => {};
  private errorHandler: (message: string) => void = () => {};

  constructor(url: string = APPLE_DEFAULT_URL,
              wsFactory: (url: string) => WebSocketLike = (u) => new WebSocket(u) as unknown as WebSocketLike) {
    this.ws = wsFactory(url);
    this.ws.on("open", () => {
      this.opened = true;
      for (const chunk of this.pending) this.ws.send(chunk);
      this.pending = [];
    });
    this.ws.on("message", (data: Buffer | string) => {
      let parsed: any;
      try { parsed = JSON.parse(String(data)); } catch { return; }
      if (parsed.ready) this.readyHandler();
      else if (typeof parsed.text === "string") {
        this.transcriptHandler({ text: parsed.text, isFinal: !!parsed.isFinal });
      } else if (typeof parsed.error === "string") this.errorHandler(parsed.error);
    });
    this.ws.on("close", () => {
      if (!this.closed) this.errorHandler("transcriber connection lost");
    });
    this.ws.on("error", (err: Error) => {
      if (!this.closed) this.errorHandler(err.message);
    });
  }

  onTranscript(handler: (t: Transcript) => void): void { this.transcriptHandler = handler; }
  onReady(handler: () => void): void { this.readyHandler = handler; }
  onError(handler: (message: string) => void): void { this.errorHandler = handler; }

  sendAudio(chunk: Buffer): void {
    if (this.closed) return;
    if (this.opened) this.ws.send(chunk);
    else this.pending.push(chunk);
  }

  close(): void {
    this.closed = true;
    this.ws.close();
  }
}
```

- [ ] **Step 4: Wire construction + provider name** — add `"apple"` to `PROVIDER_NAMES`; in the construction site route `apple` (and make `TRANSCRIPTION_PROVIDER=apple` selectable as the default provider) with the telephony `?format=mulaw8k` suffix. Follow the existing pattern for the other providers exactly; extend that site's existing tests with an apple case.

- [ ] **Step 5: Full backend suite** — `cd backend && npm test` — everything green.

- [ ] **Step 6: Live pairing check (local)** — with the sidecar from Task 3 running: `TRANSCRIPTION_PROVIDER=apple node --experimental-strip-types src/index.ts` (or however `backend/README.md` says to run dev) and stream `ws-smoke.mjs`-style audio through the relay's own `/stream` endpoint with a dev token; observe partials/finals. Document the exact command used in the report.

- [ ] **Step 7: Commit** — `git add backend/src/appleProvider.ts backend/src/appleProvider.test.ts backend/src/providerOptions.ts <construction site + its test> && git commit -m "feat(backend): apple provider speaking to the local transcriber sidecar"`

---

### Task 5: Deployment to ring

**Files:**
- Create: `deploy/ring/com.jonyen.caption-transcriber.plist`, `deploy/ring/com.jonyen.caption-relay.plist`, `deploy/ring/README.md`, `deploy/ring/sync.sh`

**Interfaces:**
- Consumes: everything above; `ssh ring`.
- Produces: both services running on ring, relay listening on its port (discover the relay's PORT convention from `backend/src/config.ts` — reuse it).

- [ ] **Step 1: Preflight on ring** — `ssh ring 'node --version; xcodebuild -version 2>/dev/null | head -1; tailscale version | head -1; doppler --version'`. Node must be ≥ 22.5 (install via `brew install node` if missing); Xcode is NOT expected on ring — the sidecar binary is built on this Mac and copied over (both are Apple Silicon).
- [ ] **Step 2: sync.sh** — rsync the backend (excluding node_modules) and the release-built sidecar binary (`swift build -c release`, binary at `.build/release/caption-transcriber`) to `ring:~/apps/watch-captions-relay/`; `npm ci --omit=dev` on ring; `codesign -s - --force` the copied binary if Gatekeeper complains.
- [ ] **Step 3: Doppler** — `ssh ring 'doppler configs --project personal'` to find the relay's config (the Fly app's secrets live in Doppler per the user's setup; if no config exists, create `prd_captionrelay` and set the non-Deepgram secrets the backend README lists — Gemini, auth/token salts, Twilio, Notion — values pulled with `fly ssh console -a watch-captions-relay -C env` equivalents or from the user). `TRANSCRIPTION_PROVIDER=apple` goes in the config. No `DEEPGRAM_API_KEY`.
- [ ] **Step 4: LaunchAgents** — transcriber plist runs the binary with `PORT=8790`; relay plist runs `doppler run -- node <entry>` with `WorkingDirectory` set, both `KeepAlive`, logs to `~/Library/Logs/caption-*.log`. Install with `launchctl bootstrap gui/$(id -u ring-uid) ~/Library/LaunchAgents/<plist>` via ssh; verify with `launchctl list | grep caption` and `curl` of the relay's health endpoint (find it in `backend/src/server.ts`; if none exists, the viewer page suffices).
- [ ] **Step 5: On-ring smoke** — run the Task 3 `ws-smoke.mjs` ON ring against `ws://127.0.0.1:8790` (node is there now) with a copied `hello.wav`: ready + partials + final. Then the same through the relay's `/stream` with a dev token.
- [ ] **Step 6: Commit** — `git add deploy/ring && git commit -m "feat(deploy): launchd + sync scripts for the relay and transcriber on ring"`

---

### Task 6: Tailscale Funnel exposure

**Files:**
- Modify: `deploy/ring/README.md` (record the funnel URL and commands)

- [ ] **Step 1:** `ssh ring 'tailscale funnel --bg <relay-port>'` (the doorlog `tailscale serve` config already on ring must keep working — check `tailscale serve status` first and use a distinct path or port; funnel and serve coexist, but do NOT clobber the doorlog mapping).
- [ ] **Step 2:** From this Mac (off-tailnet check: use `curl --interface` normally — the funnel URL is public): `curl https://ring.<tailnet>.ts.net[:port]/<health-or-viewer>` succeeds; then run the ws-smoke stream against `wss://…/stream` with a dev token end-to-end.
- [ ] **Step 3: Commit** — `git add deploy/ring/README.md && git commit -m "docs(deploy): funnel exposure for the relay on ring"`

---

### Task 7: Data migration and cutover

**Files:**
- Modify (NOT committed — untracked secrets): `watch/WatchCaptions/Secrets.swift`, `ios/Shared/Secrets.swift`
- Modify: `backend/DEPLOY.md` (new deployment reality), `README.md` (architecture line)

- [ ] **Step 1: Copy the SQLite database** — find the volume path in `fly.toml`/`backend/src/config.ts`; `fly ssh sftp get <db-path> ./relay.db -a watch-captions-relay`, stop the relay LaunchAgent on ring, copy the db into place, restart, and verify history shows in the viewer page.
- [ ] **Step 2: Point the apps at the funnel** — swap `relayURL` in both Secrets files (wss for watch, https for ios), rebuild + install the watch app on the user's watch (`xcodebuild … -destination 'platform=watchOS,id=636B0687-5588-5670-8A97-1B2CC463D774' -allowProvisioningUpdates build` + `devicectl device install app`), and the iOS app if the user wants it now.
- [ ] **Step 3: Twilio webhook** — surface the exact Twilio console change (or `twilio` CLI command) for the user; do not change it without telling them — calls cut over the moment it changes.
- [ ] **Step 4: Verify with the user** — a relay session from the watch through the funnel shows partials/finals and lands in history; summaries still generate (Gemini key present).
- [ ] **Step 5: Commit docs** — `git add backend/DEPLOY.md README.md && git commit -m "docs: relay now runs on ring with local Apple transcription"`
- [ ] **Step 6: Hand the user the retirement checklist** — soak for a few days, then: `fly scale count 0 -a watch-captions-relay` (or `fly apps destroy`), revoke the Deepgram API key, remove `DEEPGRAM_API_KEY` from secrets. These are the user's actions, not this plan's.

---

## Self-review notes

- Spec coverage: sidecar protocol (T1–T3), provider + selection + telephony format (T4), ring deployment + launchd + Doppler (T5), funnel (T6), migration/cutover/retirement checklist (T7). Out-of-scope items from the spec stay out.
- The SpeechAnalyzer code in Task 2 is explicitly marked as needing doc verification — that task's deliverable is the working smoke run, not the sketch.
- Type/name consistency: `WireFormat`/`PCMDecoder`/`TranscriberSession` names used in Tasks 1→3; provider name `"apple"`, `APPLE_TRANSCRIBER_URL`, port 8790 used consistently in Tasks 3→5.
