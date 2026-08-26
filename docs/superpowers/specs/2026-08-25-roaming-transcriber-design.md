# Roaming transcriber — design

The watch's best transcriber should follow the user. Apple's SpeechTranscriber —
the engine that won every quality comparison in this project — runs locally on
iOS 26, so the iPhone in the user's pocket can transcribe with iMac quality
anywhere, over Bluetooth, with no network at all. This design makes the phone
the preferred remote transcriber, collapses the watch's modes to two, and makes
kept sessions survive roaming by store-and-forwarding through the phone.

Decisions made with the user on 2026-08-25:

1. **Transport is WatchConnectivity** — the phone-nearby-nothing-else case must
   work (pure Bluetooth range, no Wi-Fi, no cellular).
2. **The phone is the preferred transcriber.** The iMac's transcription role
   retreats to fallback (and offline labeling for the training dataset); its
   primary jobs remain storage, history, exports, summaries, training capture.
3. **Two modes: Auto / Watch only.** Auto = instant local partials plus
   best-available remote finals (phone → iMac relay → none). Watch only = the
   existing pure on-device mode. Nobody picks a transcriber by hand.
4. **Kept sessions forward through the phone**: the phone queues transcript
   text on disk and delivers it to the relay over its own connectivity,
   whenever that returns. Kept sessions genuinely work everywhere.

## Architecture

```
            WatchConnectivity (Bluetooth/Wi-Fi, no infrastructure)
Watch ──────────────────────────────────────────────► iPhone
  HybridEngine                                          WCTranscriberService
    ├─ local: OnDeviceEngine (Moonshine)                  └─ TranscriberCore
    └─ remote leg, chosen per session:                        (SpeechAnalyzer)
         1. PhoneEngine (WCSession)                     ForwardingStore ──► iMac relay
         2. HTTPRelayClient (network)                     (queued /v1/captions,
         3. none (pure local)                              /v1/audio-archive)
```

- **`TranscriberCore`** — a new local Swift package extracting the reviewed
  `TranscriberSession` + `PCMDecoder` from `transcriber-mac` (the SpeechAnalyzer
  API is identical on iOS 26 and macOS 26). Both the Mac sidecar and the iOS
  app consume it; one implementation everywhere.
- **`PhoneEngine`** (watch) — a `CaptionEngine` sibling of `HTTPRelayClient`:
  streams PCM over `WCSession`, receives caption events, same event contract,
  so it plugs into `HybridEngine` as an alternative remote leg with zero
  arbitration changes.
- **`WCTranscriberService`** (iPhone) — maps the wire protocol onto one
  `TranscriberSession` per watch session.
- **`ForwardingStore`** (iPhone) — kept sessions' finals appended to an
  on-disk queue, replayed against the relay's existing `/v1/captions` +
  `/v1/stop` until delivered; audio optionally forwarded to `/v1/audio-archive`
  on Wi-Fi for the training dataset.
- **Relay: zero changes.** Every endpoint the phone forwards to already exists
  and is already reviewed.

## Wire protocol (watch ↔ phone, over WCSession)

Binary messages: a small JSON header, then the PCM payload where applicable.

- Watch → phone: `begin` (sessionId, keep flag, bearer token when kept),
  `audio` (sequence-numbered 16 kHz mono s16le chunks, ~0.25 s each, matching
  the relay cadence), `finish`.
- Phone → watch: `ready`, `caption {text, isFinal}` (partials are cumulative,
  the project-wide convention), `error {message}`.
- Audio uses `sendMessageData` while `isReachable`; stale audio is never
  queued — live captioning wants freshness, and a dropped chunk is dropped.
  Transcript FORWARDING (phone → relay) is the queued, reliable path; the
  live caption stream is best-effort by design.

## Mode model and migration

The mode button cycles **Auto ↔ Watch only**. Stored `captureMode` migrates:
`local` → Watch only; `cloud` and `hybrid` → Auto. Auto probes at session
start: `WCSession.isReachable` → phone; else relay reachable → iMac; else pure
local (the session still starts instantly either way — local partials never
wait for the probe). Mid-session remote loss lands on the existing
`relayDied()` degrade path unchanged, including the no-finals watchdog.

## Auth

The watch owns identity. For a kept session it hands the phone its bearer
token inside `begin`; the phone replays the relay calls as the watch, and
transcripts land under the watch's user exactly as today. The token crosses
only the encrypted watch↔phone channel and is held only in the forwarding
queue entry that needs it, deleted on delivery.

## Failure semantics

- Phone transcriber error → `error` frame → watch degrades to local. Captions
  never stall on any remote failure; this is the project's standing hard
  requirement.
- Forwarding failures are invisible to live captioning; the queue holds and
  retries. The watch indicator reflects *confirmed* persistence only (the
  existing honesty rule); a session forwarded later completes in history
  after the fact.
- Both-engines-dead remains the only session-ending state.

## Verification

Paired watch + phone **simulators support WCSession**, so the protocol, both
engines, and the service get simulator end-to-end coverage. What simulators
cannot prove is real Bluetooth throughput and latency — so the plan's first
task is a **device spike**: stream sustained 32 KB/s PCM watch → phone with
captions coming back, measuring throughput, round-trip latency, and drop rate
on the user's actual Series 10 + iPhone 16. That spike is the go/no-go gate
for the rest of the build.

## Out of scope (v1)

- Multi-locale; per-session language selection.
- Forwarding audio over cellular (Wi-Fi only for `/v1/audio-archive`; text
  forwards on any connectivity).
- The iMac-side labeler upgrade (Parakeet-TDT-0.6B evaluation) — a separate
  track already in flight; whichever labeler wins, this design is unaffected.
- Retiring the iMac relay leg from Auto: it stays as silent fallback #2.
