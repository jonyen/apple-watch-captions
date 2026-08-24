# iMac relay with local speech-to-text — design

Decisions made with the user on 2026-08-24:

1. **The whole relay moves to the iMac** (Tailscale host `ring`, Apple M4, macOS 26.5,
   16 GB). Fly.io and Deepgram both retire after cutover. The watch's on-device mode
   covers captioning away from home when the iMac is unreachable.
2. **STT is Apple's SpeechTranscriber** (the macOS 26 SpeechAnalyzer API family):
   Whisper-large-class accuracy, ~2× Whisper's speed, ~42 locales, fully local, models
   are system assets (no files for us to manage). The Node relay cannot call Swift, so a
   small Swift sidecar exposes it over a localhost WebSocket.
3. **The watch reaches the iMac through Tailscale Funnel** — a public HTTPS/WSS URL
   terminating on `ring`, guarded by the relay's existing token auth, exactly like the
   Fly URL today. Twilio webhooks move to the same URL.

## Components

```
Watch/iPhone ──wss (Funnel)──► ring: Node relay (backend/, unchanged product)
                                        │ ws://127.0.0.1:8790
                                        ▼
                               ring: caption-transcriber (Swift sidecar)
                                        │ SpeechAnalyzer / SpeechTranscriber
                                        ▼
                                macOS 26 system speech models
```

## Sidecar protocol (the contract between Node and Swift)

WebSocket server on `127.0.0.1:8790` (env `PORT` overrides). One WS connection per
transcription session.

- Client → server, binary frames: raw PCM, 16 kHz, mono, s16le — the same bytes the
  relay feeds Deepgram today.
- Server → client, text frames, one JSON object each:
  - `{"ready": true}` — sent once when the transcriber is set up and audio may flow.
  - `{"text": "...", "isFinal": false}` — volatile (partial) result; replaces the
    previous partial.
  - `{"text": "...", "isFinal": true}` — finalized segment.
  - `{"error": "message"}` — fatal; the server closes the connection after sending.
- Client closes the socket to end the session; the sidecar finalizes and drops state.
- Query parameter `?locale=en-US` optional; default `en-US`.
- Query parameter `?format=pcm16k|mulaw8k`, default `pcm16k`. `mulaw8k` is Twilio
  call audio (µ-law, 8 kHz mono); the sidecar decodes µ-law and lets its
  AVAudioConverter resample, so call captions survive Deepgram's departure.

## Node side

`AppleTranscriptionProvider` implements the existing 5-method `TranscriptionProvider`
interface over that protocol. Provider selection: `TRANSCRIPTION_PROVIDER=apple` joins
the existing deepgram/assemblyai/openai/fake options. `APPLE_TRANSCRIBER_URL` env,
default `ws://127.0.0.1:8790`. Channel-split (Twilio call) sessions keep using the
existing `channelSplitProvider` wrapper, now wrapping two apple providers — the wrapper
is provider-agnostic.

## Deployment on ring

- Node ≥ 22.5 (for `node:sqlite`), repo synced to `~/apps/watch-captions-relay`.
- Secrets via the existing Doppler `personal` project (config discovered at execution;
  Gemini key stays for summaries, Deepgram key dropped).
- Two launchd **user agents** (Aqua session, so TCC/asset downloads behave):
  `com.jonyen.caption-transcriber` and `com.jonyen.caption-relay`, KeepAlive.
- SQLite database copied from the Fly volume during cutover.
- `tailscale funnel` exposes the relay port; the funnel URL replaces the Fly URL in
  `watch/WatchCaptions/Secrets.swift`, `ios/Shared/Secrets.swift`, and the Twilio
  webhook configuration.

## Out of scope (v1)

- Multi-locale switching mid-session (locale fixed per session).
- Retiring the Fly app and revoking the Deepgram key are user actions after the
  cutover soak; the plan ends with a checklist, not the deletion.
- The sidecar does not touch the microphone — audio arrives over the socket — so no
  mic TCC prompt is expected. Speech model download via AssetInventory happens on
  first run.

## Risks

- SpeechAnalyzer API details (exact initializer/option names) must be verified against
  Apple docs at implementation time; WWDC25 session 277 and
  developer.apple.com/documentation/speech are the references.
- SpeechTranscriber has hardware gates on some devices; M4 comfortably qualifies.
- Funnel bandwidth: one session is ~32 KB/s upstream PCM — trivial.
