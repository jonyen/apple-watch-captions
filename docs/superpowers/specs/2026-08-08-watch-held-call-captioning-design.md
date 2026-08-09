# Watch-held calls: Twilio holds the line, the watch reads and speaks

## Problem

The [call captioning prototype](2026-08-05-twilio-call-captioning-design.md) works.
A caller dials a Twilio number, their audio is forked to the relay, and captions
appear on the wrist about two seconds later. Verified on a live call: 40 mm is
enough screen, and two seconds is readable.

It has one constraint, discovered the hard way: **the iPhone must hold the call.**
Answer on the Watch instead and watchOS shows *"End call to continue"* and refuses
to open any app. There is no API or entitlement that changes this — a third-party
app simply cannot draw over a watch-held call.

That constraint defeats the scenario the feature exists for. The phone is not
with you; the call arrives on the Watch; you cannot read it. And hearing aids pair
to the iPhone, not the Watch, so a watch-held call is also the one where hearing it
is hardest.

Phase 1 left a second problem unsolved: callers must dial the Twilio number.
Forwarding a real number loops, because Twilio has to put the call somewhere, and
dialling the forwarded number sends it straight back. Every forwarding mode loops —
unconditional, busy, and no-answer alike.

## The insight: one change solves both

**The loop exists only because Twilio dials back. The UI lock exists only because
the Watch is in a call.** If Twilio answers and *holds* the call, neither happens:

| Problem | Why it disappears |
|---|---|
| Forwarding the real number loops | Twilio never dials the forwarded number, so nothing returns through the forward |
| watchOS locks the screen during a call | Neither phone nor Watch is in a call; there is no call UI to lock |

No second line for the primary path, no SIP client, no iPhone companion app. The
real number, the Watch, captions — and now audio and speech as well.

## Scope: this is 2a

Two phases, deliberately split, because one is cheap and answers the risky question
while the other is expensive and only matters if the answer is yes.

- **2a (this spec)** — Twilio holds the call, the Watch reads captions, hears the
  caller, and speaks back. Testable with a prearranged call by opening the app.
- **2b (later)** — the *ring*. Push notifications so the Watch knows a call is
  happening when you are not expecting one. APNs key, push entitlement, device-token
  registration. Entirely independent, and pointless if 2a proves unusable.

2a answers the question that decides the idea: **whether one to two seconds of lag
on your own speech is survivable for the person listening.** Phase 1 validated the
receive path only. Reading someone late is comfortable; replying late is a different
sensation, experienced by the caller as dead air.

## Call flow

```
Caller dials your real number
   │  carrier forwards →
   ▼
POST /twilio/voice?attempt=N
   │
   ├─ watch present?
   │     → <Connect><Stream url="wss://…/twilio/stream/<token>"/></Connect>
   │
   ├─ not present, N under the wait budget?
   │     → <Play>ringback</Play><Redirect>/twilio/voice?attempt=N+1</Redirect>
   │
   └─ budget exhausted?
         → <Dial>+1‑second‑line</Dial>          (your phone rings normally)

Once connected — one bidirectional WebSocket:
   caller audio ─┬─► Deepgram ──► captions ──► watch polls   (built in phase 1)
                 └─► audio buffer ─────────► watch polls ──► watch speaker
   watch mic (push-to-talk) ──► POST ──► relay ──► media frames ──► caller
```

**`<Connect><Stream>` is the blocking form, and that is the whole trick.** The call
lives exactly as long as the WebSocket does. Ending the call on the Watch closes the
socket and the call ends — no REST call, no separate hangup path. Phase 1 used
`<Start><Stream>` precisely because it does *not* block; here the opposite property
is what makes Twilio the call's owner.

**The wait budget rides in the URL.** `?attempt=N` means Twilio carries the retry
count, so the relay stays stateless about ringing — no timers, no per-call
bookkeeping.

**"Watch present" is a recent poll.** The Watch already polls `GET /v1/call`; if it
has done so **within the last 10 seconds**, it is there. This reuses running
machinery rather than inventing a registration protocol, and it is exactly the
signal that 2b's push notification will later replace.

Phase 1 already supports polling before a call exists, which is what waiting
requires: `CallCaptions.poll()` treats an inactive answer seen *before* any active
one as "keep going," precisely so entering call mode can race the relay noticing
the call. Waiting for a call that has not arrived is the same state. No new
logic — the `wasActive` guard already covers it.

## Ringing

The caller must hear something while the Watch is given a chance to answer. Silence
reads as a broken call, so the relay serves a short ringback tone that `<Play>`
loops between redirects.

Budget: roughly five attempts of four seconds, about twenty seconds of ringing,
then the fallback dial. Configurable, because the right number is a matter of taste
and nobody knows it yet.

## Audio

**Downlink — the caller, to the Watch speaker.** Twilio's μ-law reaches the Watch
untouched: one byte per sample, 8 KB/s, and decoding is a 256-entry table. The
relay does not transcode, exactly as it does not for Deepgram.

This was chosen with a known cost. watchOS forbids WebSockets (TN3135), so audio
arrives HTTP-polled in roughly one-second batches: **about two seconds late, and
prone to gaps whenever a poll stalls.** It will sound like a poor speakerphone
rather than a phone call, and stale turn-taking cues may fight the captions rather
than support them. That was raised and the tradeoff accepted deliberately —
recorded here so a future reader does not mistake it for an oversight.

**Uplink — your voice, to the caller.** The Watch keeps producing the 16 kHz Int16
its capture pipeline already makes; the relay downsamples to 8 kHz μ-law and sends
media frames back over the same WebSocket. No new audio format anywhere on the
Watch.

## Push-to-talk

The mic is live only while a control is held.

This is not a preference; it removes echo by construction. With the speaker playing
the caller and an open mic, the Watch would send the caller back to themselves about
four seconds late — disorienting to speak over. `AudioCapture` uses `.measurement`
mode, which *disables* the processing that would cancel it, and a two-second-delayed
echo is the case echo cancellers handle worst. Push-to-talk means the speaker is
never playing while the mic is open. Playback pauses while transmitting, as a second
line of defence.

**The whole caption area is the talk target** — press and hold anywhere. Captions
keep the full screen, the target is large, and scrolling is the Digital Crown so
touch is otherwise unused. The risk is transmitting a second of ambient noise from a
stray press, so a clear "talking" indicator makes that visible rather than silent.

Rejected: a bottom talk bar, which costs caption space on the binding constraint.

## Relay

### New modules

- **`callPresence.ts`** — when the Watch last polled, and whether that is recent
  enough to count. Thin, but it makes presence a named concept rather than a
  timestamp buried in a route handler.
- **`mulaw.ts`** — μ-law ↔ Int16, plus the 16 kHz → 8 kHz downsample for the uplink.
  Pure, table-driven, tested by round-trip.
- **`callAudioBuffer.ts`** — the caller's audio awaiting collection, with a cursor
  like the caption buffer. **Bounded at 5 seconds (40 KB of μ-law), dropping
  oldest.** This is live audio: if the Watch stalls, a backlog is worse than a gap,
  because playing stale speech puts the listener further behind rather than catching
  them up. Five seconds is enough to ride out a slow poll and short enough that
  what you hear is never badly out of step with what you read.

### Changed

- **`twiml.ts`** gains two builders beside `voiceResponse` — ringback-and-retry, and
  `<Connect><Stream>`. Three small pure functions rather than one that branches.
- **`twilioStreamHandler.ts`** becomes bidirectional: it already receives caller
  audio, and now also writes it to the downlink buffer and sends uplink media frames
  back to Twilio.
- **`server.ts`**: `/twilio/voice` becomes a three-way decision.

### New routes

- `GET /v1/call/audio?since=N` → raw μ-law with a cursor header. Binary rather than
  base64-in-JSON: a third less data on the link that is already the bottleneck.
- `POST /v1/call/audio` → 16 kHz Int16 from the mic while push-to-talk is held.

`GET /v1/call` also marks presence, which is what makes the ringing decision work.

### Config

The wait budget, and `TWILIO_FORWARD_TO` keeps its name but changes meaning: it
becomes the second line Twilio falls back to, rather than the number it always
dials.

### Cleanup

The WebSocket upgrade logging added while chasing phase 1's token bug is still
running in production. It comes out as part of this work.

## Watch

### New in CaptionCore

- **`MuLaw.decode`** — μ-law bytes to Int16, mirroring the relay's encoder.
- **`CallAudio`** — polls the downlink, tracks the cursor, and owns the jitter
  policy: how much to buffer before starting, and what to do when a poll is late.
- **`CallVoice`** — push-to-talk state and upload batching.

Three small types rather than one, each testable against a fake client.
`CallCaptions` is unchanged and stays exactly what it is: captions.
`AppModel` coordinates them, as it already coordinates `SessionController` and
`CallCaptions`.

### In the app

- **`RelayCallAudioClient`** — the two new endpoints, following `RelayCallClient`.
- **`CallAudioPlayer`** — an `AVAudioEngine` player node scheduling buffers as they
  arrive, with the session in `.playAndRecord` so playback and push-to-talk coexist
  without renegotiating mid-call.
- **A "Take call" row** on the menu, entering a waiting state that polls and shows
  ringing until the stream connects. In 2b a push notification replaces this tap.

## Failure modes

**Lowering your wrist is the one to watch.** Suspending the app would kill playback
and push-to-talk mid-call. The app already declares `UIBackgroundModes: audio`, and
since it now genuinely plays audio, that should keep it alive with the screen off.
This is the difference between a usable call and one that dies when you glance
away — **verify it early; it is foundational, not polish.**

**The caller hangs up, or the stream drops** → `<Connect>` ends and the call is over;
the Watch shows it ended.

**Deepgram drops** → captions stop, audio continues. Phase 1's reconnect applies.

**The relay restarts** → every call dies. Accepted; it is a single-machine prototype.

**The Watch stalls mid-call** → the audio buffer drops oldest rather than
accumulating, for the reason given above.

**Voicemail solves itself.** Falling back to the second line means that line's
carrier voicemail catches unanswered calls, so forwarding the real number does not
cost the voicemail it otherwise would.

## Accepted limits

- One call at a time.
- No ring — the Watch must already be in the app. That is 2b.
- Audio will sound like a poor speakerphone: roughly two seconds late, with gaps.
- No Twilio signature validation, carried over from phase 1.
- You read and speak but do not hear through your hearing aids, since the iPhone is
  not in the call.

## Testing

Unit tests for μ-law round-trips, presence freshness, the three TwiML shapes, buffer
bounding and cursor behaviour. The bidirectional handler is driven with fake frames
through a fake socket, asserting that media goes **back** as well as forward. HTTP
tests for both audio routes via the existing `startServer` + `fetch` pattern.

On the Watch: `MuLaw.decode`, `CallAudio`'s jitter policy, and `CallVoice` batching,
each against a fake client.

No test contacts Twilio or Deepgram. One real call verifies the whole path.

## Setup (yours)

1. A second eSIM line for Twilio to fall back to.
2. **Confirm your carrier permits forward-then-dial before paying for that line** —
   the whole fallback rests on it.
3. Forward your real number to the Twilio number.
4. `TWILIO_FORWARD_TO` → the second line.

## What this proves, and what happens next

Success means a caller dials your real number, your Watch rings, you read them and
speak back, and your phone is never involved.

The question it answers is narrower and more important: **is a conversation workable
when your replies arrive one to two seconds late?** If yes, 2b (the ring) is worth
building and this becomes something you can actually rely on. If no, then the honest
finding is that watchOS's polling constraint makes two-way calling untenable, and the
phase 1 shape — phone holds the call, watch shows captions — is the product.

Either way it is answerable in a call or two, which is why it is worth building
before the push infrastructure.
