# watchOS Live-Caption App — Design Spec

**Date:** 2026-06-14
**Status:** Approved design, pre-implementation
**Depends on:** the deployed Phase 1 backend relay (`wss://watch-captions-relay.fly.dev/stream`).
See `2026-06-14-apple-watch-captions-design.md` (parent) and `backend/README.md` (protocol).

## 1. Purpose & scope

A **standalone watchOS app** (no iOS companion in Phase 1) that captions an in-person speaker
on the wrist. It captures the Watch microphone, streams 16 kHz mono PCM to the live relay over a
secure WebSocket, and renders the relay's captions (partial → final) in real time.

**In scope:** mic capture, audio streaming, live caption rendering, focus-driven start/stop,
error handling. **Out of scope (YAGNI):** iOS companion, call mode (Phase 2), transcript
persistence/export, auto-reconnect with backoff, translation/multi-language.

## 2. Interaction model — runs while the app is open

No Start/Stop buttons. Listening is driven by app focus (`scenePhase`):

- **Becomes active** → request mic permission (first time) → connect → stream automatically.
- **Backgrounds / wrist down (`.inactive`/`.background`)** → stop capture, close socket.

States: `connecting → listening → error`. The transcript is a fresh session each time the app
becomes active (cleared on start).

### Screens
- **Connecting** — brief "Connecting…" until the relay sends `{"type":"ready"}`.
- **Listening** (Layout A) — full-screen scrolling transcript: committed lines (`isFinal:true`)
  stack newest-at-bottom; the live partial line (`isFinal:false`) renders **dimmed** at the
  bottom and refines in place, then commits. **Auto-scrolls** to newest. A small **green "live"
  dot** (top-right) shows while `state == .listening`. No on-screen buttons.
- **Error** — message (e.g. "Connection lost") + **Try Again** button that re-runs start.
- **Permission denied** — error variant explaining how to enable the mic in Settings.

## 3. Components

| Unit | Responsibility | Tested |
|---|---|---|
| `Secrets.swift` (gitignored) + `Secrets.example.swift` (committed template) | `relayURL: URL`, `authToken: String` | n/a |
| `ServerMessage` (Codable enum) | Decode relay JSON → `.ready` / `.caption(text,isFinal)` / `.error(message)` | ✅ unit |
| `CaptionStore` (`ObservableObject`) | `lines: [String]`, `partial: String`, `state`; `apply(_ message:)` | ✅ unit |
| `RelayClient` | `URLSessionWebSocketTask`: connect, `send(Data)`, receive loop → decoded `ServerMessage` | device/manual |
| `AudioCapture` | `AVAudioEngine` mic tap → `AVAudioConverter` → 16 kHz mono Int16 PCM chunks via callback | device/manual |
| `SessionController` | Orchestrates start/stop; wires audio→client and client→store; owns lifecycle | device/manual |
| SwiftUI views | `CaptionView`, `ConnectingView`, `ErrorView`; `WatchCaptionsApp` (scenePhase) | device/manual |

Pure logic (`ServerMessage`, `CaptionStore`) is isolated so it unit-tests on the watchOS
**Simulator** with no physical watch. Audio + live socket verify **on-device against the live
relay**.

## 4. Data flow

**On `scenePhase == .active` → `SessionController.start()`:**
1. Request/check mic permission (`AVAudioSession` record permission). Denied → error state.
2. Configure & activate `AVAudioSession` (`.record`).
3. `RelayClient.connect()` to `relayURL?token=<authToken>`; start receive loop.
4. On `{"type":"ready"}` → `state = .listening`.
5. `AudioCapture.start()` — tap input node (hardware format, e.g. 48 kHz Float32) →
   `AVAudioConverter` to **16 kHz mono Int16** → send each ~100 ms chunk as a **binary** WS frame.

**Inbound receive loop** → `CaptionStore.apply(_:)` on the main actor:
- `.ready` → `state = .listening`
- `.caption(text, isFinal:false)` → `partial = text`
- `.caption(text, isFinal:true)` → append to `lines`, clear `partial`
- `.error(msg)` → `state = .error(msg)`, tear down

**On `.inactive`/`.background` → `SessionController.stop()`:** stop capture, close socket,
deactivate audio session.

**Disconnect/failure:** receive-loop failure or unexpected close → `state = .error("Connection
lost")`; **Try Again** re-runs `start()`.

## 5. Audio format contract

Raw **linear PCM, 16-bit signed little-endian, 16 kHz, mono** — matches the relay/Deepgram
(`backend/README.md`). Sent as binary WebSocket frames, ~100 ms each. Client MUST wait for
`{"type":"ready"}` before sending audio (frames sent earlier are dropped — per the relay note).

## 6. Project setup

- **Standalone watchOS app**, SwiftUI App lifecycle, single watch target. Deployment target
  watchOS 10.0+.
- Scaffolded with **XcodeGen** (`project.yml`) for a reproducible, reviewable project definition
  (fallback: Xcode's watchOS App template if XcodeGen is unavailable).
- **Secrets:** `Secrets.swift` (gitignored) defines `enum Secrets { static let relayURL; static
  let authToken }`. `Secrets.example.swift` committed as a template. Add `Secrets.swift` to
  `.gitignore`. The auth token from the Fly deploy goes here (never committed).
- **Info.plist:** `NSMicrophoneUsageDescription`.

### File structure
```
watch/
  project.yml                       # XcodeGen
  WatchCaptions/
    WatchCaptionsApp.swift          # @main App, scenePhase → start/stop
    Secrets.example.swift           # committed template
    Secrets.swift                   # gitignored, real URL+token
    Models/ServerMessage.swift
    State/CaptionStore.swift
    Net/RelayClient.swift
    Audio/AudioCapture.swift
    Session/SessionController.swift
    Views/CaptionView.swift
    Views/ConnectingView.swift
    Views/ErrorView.swift
    Info.plist
  WatchCaptionsTests/
    ServerMessageTests.swift
    CaptionStoreTests.swift
```

## 7. Testing approach

- **Unit (automated, watchOS Simulator via `xcodebuild test`):**
  - `ServerMessageTests` — decode each JSON shape (`ready`, partial caption, final caption,
    error) into the enum; reject malformed.
  - `CaptionStoreTests` — `apply(_:)` transitions: ready→listening; partial sets `partial`;
    final appends to `lines` and clears `partial`; error→error state.
- **Manual (on-device, against the live relay):**
  - Build to the physical Watch, open app → permission prompt → speak → confirm live captions
    matching speech; verify partial-then-final behavior and auto-scroll.
  - Permission-denied path shows the guidance state.
  - Error path: temporarily point `Secrets.authToken` at a wrong value → relay closes (4001) →
    app shows error + Try Again.
  - Background/foreground: lower wrist / leave app stops streaming; reopening starts fresh.

## 8. Error handling summary

| Condition | Behavior |
|---|---|
| Mic permission denied | Error state with Settings guidance |
| WebSocket connect fails / closes unexpectedly | `state = .error("Connection lost")` + Try Again |
| Relay sends `{"type":"error"}` | `state = .error(message)`, tear down |
| Bad token (relay closes 4001) | Surfaces as connection error + Try Again |
| App backgrounded mid-session | Clean stop (capture off, socket closed) |
