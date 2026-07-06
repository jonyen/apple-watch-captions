# macOS Transcription App — Design

**Date:** 2026-07-06
**Status:** Approved

## Goal

A native macOS companion to the watch captions app: live captions on the Mac for
both room conversation (mic) and Mac playback (Zoom/Meet/videos via system
audio), streamed through the existing Fly relay so transcripts, Claude
summaries, and the web viewer work for Mac sessions automatically. Transcripts
"sync" across devices by keeping the relay as the single source of truth — the
Mac app browses them natively; any other device uses the web viewer. The email
notification is removed.

## Non-goals

- Native iOS app (future project; iPhone uses the web viewer).
- CloudKit/iCloud sync (relay is the source of truth).
- Speaker diarization beyond the two capture channels.

## Architecture

```
mac/ (new, SwiftUI, macOS 14+)
 ├── references watch/CaptionCore (unchanged: SessionController, CaptionStore,
 │    Relay protocol, ServerMessage)
 ├── WebSocketRelay      — URLSessionWebSocketTask → wss://…/stream
 ├── DualCapture         — mic (AVAudioEngine) + system audio (ScreenCaptureKit)
 ├── MenuBarExtra UI     — start/stop, source toggles, Transcripts, Settings
 ├── CaptionPanel        — floating always-on-top translucent panel
 └── TranscriptsWindow   — lists/reads sessions via /v1/transcripts
```

Backend (existing `backend/`) gains multichannel support and WS transcript
persistence; loses the email notifier.

## Mac app components

### WebSocketRelay (conforms to CaptionCore.Relay)

- Connects to `wss://<relay>/stream?token=<t>&channels=2`.
- Sends binary PCM frames; receives the same JSON messages the watch parses
  (`ready` / `caption` / `error`), plus an optional `channel` field on captions.
- Auto-reconnects with capped exponential backoff (0.5s → 8s) without ending
  the user-visible session; surfaces an error only after ~30s of failures.

### DualCapture

- **Mic:** AVAudioEngine input tap → convert to 16 kHz mono Int16 (same
  approach as the watch `AudioCapture`).
- **System audio:** ScreenCaptureKit `SCStream` audio output (excluding the
  app's own audio), resampled to 16 kHz mono Int16.
- Each source writes into a ring buffer. A 100 ms timer interleaves the two
  buffers into stereo frames — channel 0 = mic ("Me"), channel 1 = system
  ("Them") — padding silence on underrun so the channels stay time-aligned.
- Either source can be toggled off; its channel carries silence so the frame
  format never changes mid-session.
- Permissions: microphone + Screen Recording (macOS requires the latter for
  system-audio capture).

### UI

- `MenuBarExtra`: Start/Stop captions, mic toggle, system-audio toggle, "Open
  Transcripts", Settings, Quit. Icon reflects capturing state.
- Caption panel: non-activating floating `NSPanel` (`.floating` level,
  translucent), draggable, shows the last ~4 caption lines prefixed **Me:** /
  **Them:** according to `channel`. Interim captions replace in place; finals
  scroll up.
- Transcripts window: list from `GET /v1/transcripts` (date, caption count,
  preview, summary badge); detail shows summary + tagged transcript lines.
- Settings: relay URL + auth token (token stored in Keychain, URL in
  UserDefaults).

## Protocol changes

- `caption` messages and transcript JSONL lines gain optional `channel: 0 | 1`.
  Absent = mono legacy (watch unchanged).
- `/stream` upgrade accepts `?channels=2`; the session's Deepgram connection is
  opened with `channels: 2, multichannel: true`. Default remains mono.

## Backend changes

1. **Multichannel provider options.** `DeepgramProvider` accepts per-session
   option overrides; Deepgram transcript events carry `channel_index` → mapped
   into `Transcript.channel` → `caption` events → JSONL lines.
2. **WS transcript persistence.** WS connections currently bypass the
   `SessionStore`/`TranscriptStore` (only HTTP sessions persist). Fix:
   `handleConnection` generates a session id, appends final captions to the
   same `TranscriptStore`, finalizes on socket close. Mac sessions then get
   summaries and appear in the viewer like watch sessions.
3. **Email removal.** Delete `mailer.ts`, the email step in `finalizer.ts`,
   mail config in `config.ts`, mail docs in DEPLOY.md; unset
   `MAIL_USERNAME`/`MAIL_PASSWORD`/`NOTIFY_EMAIL_TO` on Fly. Summary generation
   stays.
4. **Summary prompt** notes channel 0 = the user speaking, channel 1 = other
   party / played audio.
5. **Viewer** renders Me/Them labels when lines carry `channel`.

## Error handling

- Deepgram drops: already handled server-side (KeepAlive + reconnect + audio
  buffering).
- Relay WS drops: Mac client reconnects with backoff; captions resume; the
  backend reaps the dead session and starts a fresh one on reconnect (a session
  boundary in the transcript is acceptable).
- Capture failures (permission revoked, SCStream error): stop session, show
  actionable error in the menu/panel.

## Testing

- **Backend (vitest):** `channels=2` passthrough to Deepgram options;
  `channel_index` mapping into caption events and JSONL; WS sessions persist
  and finalize transcripts; email code fully removed (config/finalizer tests
  updated).
- **Mac (XCTest):** interleaver (alignment, underrun padding, toggle-off
  silence); WebSocketRelay JSON parsing incl. `channel`; CaptionCore's existing
  suite runs on macOS unchanged.
- **Manual e2e:** play a video + speak simultaneously → panel shows labeled
  live captions; stop → transcript with Me/Them lines + summary in the
  Transcripts window and web viewer.
