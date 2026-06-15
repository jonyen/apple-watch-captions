# Watch HTTP transport design (2026-06-14)

## Problem

The watchOS caption app cannot use its WebSocket (`URLSessionWebSocketTask`) to reach the
relay. Per Apple TN3135, `URLSessionWebSocketTask` is *low-level networking*, which watchOS
blocks for normal apps (`NWPathMonitor` stays `.unsatisfied`), strictly enforced on watchOS 9+.
The only WebSocket-compatible exemption is an active CallKit call — proven to work on-device,
but the watchOS system call UI covers the app and cannot be hidden/backgrounded, so captions
are never visible. **High-level HTTP `URLSession` is always allowed** (proven: an HTTPS probe to
the relay returned `200 ok` while the WebSocket was blocked).

So: replace the WebSocket transport with HTTP request/response. No UI takeover, ~1s latency.

## Architecture

Swap the transport behind the watch's existing `Relay` protocol. `SessionController`,
`CaptionStore`, `AudioCapture`, and the views are unchanged. The WebSocket `RelayClient` is
replaced by an `HTTPRelayClient` that conforms to `Relay`. The backend gains HTTP endpoints
that reuse the existing `CaptionSession` + `DeepgramProvider`; the `/stream` WebSocket stays
for Mac-based testing.

## Backend (Node/TypeScript)

New module `sessionStore.ts` — per-session state keyed by a client-supplied session id:

```
Session = {
  caption: CaptionSession         // wraps a fresh provider; its send() appends to `events`
  events: { seq: number, payload: OutboundMessage }[]
  seq: number                     // monotonic, per session
  lastActivity: number            // ms; for idle reaping
}
```

- `getOrCreate(id)` — lazily creates a session: `createProvider()` → `new CaptionSession(provider, append)`, where `append` pushes `{seq: ++seq, payload}`. Creating the provider opens the Deepgram stream (→ a buffered `ready` event).
- `feed(id, pcm)` — `session.caption.handleAudio(pcm)`; updates `lastActivity`.
- `drain(id, since)` — returns events with `seq > since`; prunes events with `seq <= since`.
- `stop(id)` — `provider.close()`, remove from map.
- Idle reaper — `setInterval` closes + removes sessions whose `lastActivity` is older than
  `IDLE_TIMEOUT_MS` (15s), covering clients that stop without calling `/stop`.

New HTTP routes in `server.ts` (token via `?token=`, `verifyToken` → 401 on mismatch):

| Route | Request | Response (200, JSON) |
|---|---|---|
| `POST /v1/audio?session=<id>&since=<seq>` | body: raw 16 kHz mono Int16 PCM (octet-stream), may be empty | `{ "events": [{seq,type,...}], "seq": <latest> }` |
| `POST /v1/stop?session=<id>` | empty | `{ "events": [<final drained>], "seq": <latest> }` |

- Missing `session` → 400. Body size capped (e.g. 512 KB) to bound memory.
- `GET /` and `/healthz` → `200 ok` (unchanged). `/stream` WebSocket retained.

`OutboundMessage` shapes are unchanged (`ready` / `caption{text,isFinal}` / `error`).

## Watch (`HTTPRelayClient: Relay`)

Conforms to the same protocol (`connect/send/close`, `onMessage/onClose`), so
`SessionController` is unchanged.

- `init(baseURL:token:)` — builds `/v1/audio` and `/v1/stop` URLs; generates a session UUID.
- `connect()` — POST an initial empty batch. On HTTP 200: synthesize `onMessage(.ready)` once
  (so `SessionController` starts audio capture), deliver any caption events, start a ~1s flush
  timer. **Server-sent `ready` events are suppressed** (the client owns the single synthetic
  `.ready`) to avoid re-triggering `startAudio`.
- `send(_ audio:)` — append to an in-memory buffer (lock-guarded; called off the main actor).
- flush timer (~1s) — if no request is in flight, swap out the buffer and POST it with
  `since=<lastSeq>`; apply `response.seq` and deliver `caption`/`error` events via `onMessage`.
  Overlapping ticks are skipped while a request is in flight (audio keeps accumulating).
- A failed POST (network error) → `onMessage` nothing; calls `onClose` → UI shows
  "Connection lost" with Try Again.
- `close()` — stop the timer, POST `/v1/stop`.

`AudioCapture` is restored to manage its own `AVAudioSession` (`.record`/`.measurement`,
`setActive`) — there is no CallKit call to own it.

## Removals (revert the CallKit spike)

- Delete `CallManager.swift`; remove `UIBackgroundModes: [voip]` from `project.yml`.
- `AppModel` back to simple `start()/stop()` (no call, no `started` guard, no delay); construct
  `HTTPRelayClient` instead of `RelayClient`.
- `WatchCaptionsApp` back to scene-phase-driven start/stop (drop the spike `.task`).
- Strip all `RELAYDBG`/`AUDIODBG`/`CALLDBG` diagnostics.
- `RelayClient` (WebSocket) kept only for Mac testing, or deleted — TBD during cleanup.

## Testing

- `sessionStore` unit tests (vitest, `fakeTranscriptionProvider`): create, feed, seq ordering,
  `drain(since)` + pruning, idle reaping, stop.
- `server` HTTP tests: bad/missing token, missing session, audio round-trip returns buffered
  caption events, `/stop` drains + closes.
- On-device verification: open app → captions appear (no call UI), persist across multiple
  batches, stop on background.

## Tradeoffs / notes

- Latency ~1s (batch cadence). Acceptable for live captions; tunable.
- One Fly machine today → session affinity is automatic. If scaled to multiple machines later,
  sessions would need sticky routing or shared state (out of scope).
- Deployed relay currently doesn't enforce auth (observed); redeploying with this work restores
  `verifyToken` on the new endpoints.
