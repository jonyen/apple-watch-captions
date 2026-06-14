# Apple Watch Live Captions — Design Spec

**Date:** 2026-06-14
**Status:** Approved design, pre-implementation

## 1. Purpose

An accessibility app that displays **live captions on an Apple Watch** for a hard-of-hearing
user. Two capture modes share one transcription engine:

- **Live mode** — the Watch microphone captions an in-person speaker. No phone or telephony
  required. Directly serves the user's core need: read what someone is saying without pulling
  out a phone, even when the phone is not nearby.
- **Call mode** — when a captioning toggle is ON, incoming phone calls are routed through a
  VoIP number into the app, the caller's audio is transcribed, and captions appear on the Watch.

## 2. Key Constraints (why the design is shaped this way)

1. **No access to native call audio.** Neither iOS nor watchOS exposes the audio of a native
   cellular/FaceTime call to third-party apps. The caller's voice during a native call is
   sealed off — regardless of where the phone is. This is why call captioning *requires* routing
   the call through the app as a **VoIP call** (via CallKit), where the app owns the audio.
2. **Watch mic is occupied during native calls.** During a native call the Watch mic transmits
   the user's voice, so an app cannot use it to "listen" to the caller. (Live mode is unaffected —
   no call is active, so the mic is free.)
3. **No on-device transcription on watchOS.** Apple's `SFSpeechRecognizer` is not available on
   watchOS, and the Watch is too resource-constrained for continuous STT. Transcription therefore
   runs **server-side**; the Watch is a thin capture + display client.
4. **No programmatic carrier call-forwarding.** iOS has no API to silently set carrier
   forwarding. The toggle deep-links to the dialer with an MMI forwarding code (e.g.
   `*21*<twilio#>#` to enable, `#21#` to disable), which the user confirms with a tap.

## 3. Components

| Component | Responsibility |
|---|---|
| **watchOS app** | Mic capture (live mode), live caption display, on/off toggle, call UI |
| **iOS companion app** | Settings, captioning toggle / forwarding deep-link, handles VoIP calls when the phone is present, relays captions to the Watch |
| **Backend server** | Receives audio (Watch WebSocket *or* Twilio media stream), runs cloud STT, streams captions back to the active device |
| **Telephony (Twilio/SignalWire)** | Rented number used as the carrier-forwarding target; bridges forwarded calls into the app and streams call audio to the backend |
| **Cloud STT (Deepgram)** | Real-time streaming speech-to-text |

**Unifying idea:** everything funnels into **one server-side STT pipeline**. The only difference
between modes is the **audio source** (Watch mic vs. Twilio call) and which device shows captions.

## 4. Data Flow

### Live mode (Phase 1)
```
User raises wrist, taps "Listen"
  -> watchOS app opens mic, captures audio (AVAudioEngine)
  -> streams audio chunks over a WebSocket to the backend
  -> backend forwards stream to cloud STT (Deepgram)
  -> STT returns partial + final caption text in real time
  -> backend pushes caption text back over the same WebSocket
  -> watchOS app renders a live, auto-scrolling caption view
  -> tap "Stop" to end
```
- Partial results appear as words are spoken (low latency), then finalize.
- Captions auto-scroll with a few lines of history.
- Mic streaming requires the Watch app to be **foreground/active** (watchOS disallows
  indefinite background mic). Acceptable for "glance and read."

### Call mode (Phase 2)
```
Toggle ON -> iOS app deep-links dialer to set carrier forwarding to the Twilio number
Someone calls the user's real number
  -> carrier forwards -> Twilio answers, opens a media stream to backend
  -> Twilio delivers the call into the app (CallKit on iPhone, or Watch)
  -> caller audio -> backend -> same cloud STT -> captions
  -> captions pushed to whichever device answered -> displayed
Toggle OFF -> forwarding removed (#21#), calls ring natively as normal
```

## 5. Build Phasing

- **Phase 1 — Live mode.** watchOS mic -> WebSocket -> backend -> STT -> captions on Watch.
  No telephony. Proves the entire core (audio streaming, STT integration, live caption
  rendering) with the fewest moving parts, and is independently useful.
- **Phase 2 — Call mode.** Add the Twilio number, carrier-forwarding deep-link, iOS toggle, and
  CallKit, riding on the proven Phase 1 pipeline.

## 6. Known Risk — Standalone Watch VoIP calls

Phase 2's hardest sub-case is **"phone genuinely elsewhere + an incoming call captioned on the
Watch alone."** CallKit is iOS-only — watchOS has no CallKit — and third-party VoIP calling on
Apple Watch generally routes through the paired iPhone rather than running standalone.

- **Reliable:** phone in pocket/bag (has data) handles the forwarded VoIP call and **pushes
  captions to the Watch.** Satisfies "I don't want to pull my phone out."
- **Uncertain / needs a research spike:** phone truly absent, call captioned on a cellular Watch
  with no phone in the loop. May be limited or impossible under Apple's current rules.

**Decision:** the phone-totally-absent *call* case is scoped as **validate-before-promising**, not
a commitment. Live mode fully delivers the "phone not nearby" goal independently.

## 7. Tech Choices

| Layer | Choice | Why |
|---|---|---|
| watchOS app | Swift + SwiftUI, `AVAudioEngine`, `URLSessionWebSocketTask` | Native, well-supported |
| iOS companion | Swift + SwiftUI, `CallKit`, `WatchConnectivity` | Call handling + caption relay |
| Backend | **Node.js** (TypeScript), persistent **WebSocket** service | Long-lived socket for Watch audio and Twilio streams; strongest Twilio + Deepgram SDK support; pure serverless is awkward |
| Hosting | Small always-on instance (Fly.io / Render / Railway / VPS) | 24/7 reachable to answer calls |
| Cloud STT | **Deepgram** | Cheapest real-time streaming, low latency, simple API, free credit covers volume |
| Telephony | Twilio (or SignalWire) Media Streams | Streams call audio to backend over WebSocket |
| Security | Auth token on the client->backend socket | Prevents unauthorized STT use |

## 8. Cost (expected usage ~5 min/month)

- **Transcription:** effectively free at this volume (~$0.03–$0.12/mo, or $0 on free tiers).
- **Phone number rental:** ~$1.15/month, fixed.
- **Call minutes:** a few cents.
- **Server hosting:** ~$0–$5/month.
- **Realistic total: ~$1–$7/month, almost entirely fixed infrastructure.**

Noted tradeoff: this is meaningful standing infrastructure for low usage; accepted by the user.

## 9. Testing Approach

- **Backend:** TDD — unit/integration tests feeding mock audio and asserting caption output;
  mock the STT and Twilio layers.
- **Watch/iOS:** test caption view-models against fake caption streams; audio capture is
  manual-tested on-device.
- Phase 1 is fully testable end-to-end without any telephony.

## 10. Out of Scope (v1 / YAGNI)

- On-device (phone-side) transcription hybrid for privacy — deferred; single server-side pipeline.
- Translation / multi-language captions.
- Speaker diarization / labeling who spoke.
- Caption history persistence / transcripts export.
