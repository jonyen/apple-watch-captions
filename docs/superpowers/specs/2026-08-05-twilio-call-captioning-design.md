# Call captioning: reading a live phone call on the wrist

## Problem

The watch captions the room. It cannot caption a phone call, because neither iOS
nor watchOS exposes native call audio to a third-party app — and during a call the
watch mic is busy transmitting your voice, so there is nothing to listen to
either. Both blockers are verified against the watchOS 26.5 SDK: `CallKit` is
present but its only audio API is `provider:didActivate/didDeactivateAudioSession:`,
which fires for calls *your own app* reports, not for the system Phone app's.
`Speech.framework` is absent entirely.

The escape is to stop the call being native. If a telephony provider owns the
call, it can fork the audio to the relay by right, and the existing pipeline —
Deepgram, captions, the watch — works unchanged.

This spec is a **prototype**, and its question is narrow:

> Is reading a live call on your wrist actually useful?

Everything here is shaped by that question and nothing else. Decisions that would
be wrong for a product are correct here if they answer it sooner.

## Why the caller dials a Twilio number, not yours

The obvious design keeps your real number: forward it to Twilio, let Twilio bridge
the call to you. It does not work, because Twilio has to terminate the call
somewhere. If it dials your real number, your carrier's forwarding sends it back
to Twilio — a loop.

The loop exists only because the terminating leg is the same PSTN number that was
forwarded. Every genuine fix terminates somewhere else:

| Approach | Callers dial | Cost |
|---|---|---|
| **Passthrough** (chosen) | Twilio number | Nothing |
| Forward → second line | Your real number | A second eSIM line |
| Forward → SIP client | Your real number | Answer calls in a third-party SIP app |
| Forward → custom iOS app | Your real number | Build the Phase 2 companion app |

That last row is why the original design
(`2026-06-14-apple-watch-captions-design.md`) has an iPhone companion in it. It is
not incidental — a VoIP client is the standard way out of the loop.

**None of this affects the prototype's question.** Who dialled what has no bearing
on whether call captions are readable on a wrist. One real call from one real
person answers it. So the prototype changes nothing about your phone: you publish
nothing, forward nothing, and test by calling the Twilio number. If the answer is
yes, the number problem becomes worth a second line or a companion app — decided
with evidence instead of ahead of it.

## Provider: Twilio

Not the cheapest. Chosen for documentation density and worked examples of exactly
this shape (`<Start><Stream>` alongside `<Dial>`), which is what matters when the
goal is a fast answer. **SignalWire** is meaningfully cheaper and deliberately
LaML-compatible, so migrating later is close to a drop-in. Optimise cost once the
idea has earned it.

Get off the Twilio trial: trial accounts restrict outbound calls to verified
numbers and play a notice on every call, which would make the prototype feel worse
than it is.

## Call flow

```
Caller dials the Twilio number
   │
   ├─► Twilio POSTs  /twilio/voice?token=…        (relay returns TwiML)
   │      <Start><Stream url="wss://…/twilio/stream?token=…"
   │                     track="inbound_track"/></Start>
   │      <Dial>+1‑your‑real‑phone</Dial>
   │
   ├─► Twilio opens WS ──► /twilio/stream
   │      frames: connected / start / media / stop
   │      media = base64 μ‑law 8 kHz, caller's voice only
   │            │
   │            ▼
   │      SessionStore session, ephemeral — nothing written
   │            │
   │            ▼
   │      Deepgram  encoding=mulaw  sample_rate=8000  phone model
   │
   └─► <Dial> rings your real phone — you answer it normally
          │
          ▼
   Watch app opens ──► GET /v1/call?since=N ──► captions on your wrist
```

Three properties make this small:

**`<Start><Stream>` does not block.** It forks audio and TwiML execution continues
straight to `<Dial>`, so one webhook does both jobs and the caller hears normal
ringing while audio already flows. (`<Connect><Stream>` is the blocking
bidirectional variant — wrong tool.)

**No transcoding.** Twilio sends μ-law 8 kHz; Deepgram accepts μ-law 8 kHz. The
relay base64-decodes each frame and forwards the bytes untouched.

**`inbound_track` is exactly the caller.** The stream attaches to the inbound leg
before `<Dial>` bridges, so its inbound track carries only what the caller sends.
Caller-only falls out of the TwiML rather than needing filtering downstream.

## Only the caller is captioned

Twilio can fork both tracks. It is deliberately not doing so.

Your own words are the half you already know you said, and screen space on a 40 mm
display is the binding constraint. Both-sides would also need a
Twilio-frames-to-stereo adapter (Twilio delivers tracks as separately tagged
messages, not interleaved) and two-speaker UI where none exists today.

`ChannelSplitProvider` already handles two-channel attribution, so this is a
cheap upgrade later if reading a call turns out to be worth it.

## Nothing is kept

Call sessions are **ephemeral**, reusing `SessionMode.live` and the relay's
existing `ephemeral=1` path: no transcript file, no summary, no Notion export.

Transcribing a call is recording it in most two-party-consent jurisdictions, and
the default should not quietly accumulate recordings of people who never agreed to
one. Ephemeral is also simply correct for the prototype — the question is about
reading live, not about the archive.

The caller's audio still leaves the phone network and passes through the relay and
Deepgram. Storing nothing does not change that.

## Relay

### New modules

All three are pure and testable without a socket:

- **`twilioFrames.ts`** — parses one raw Twilio JSON frame into meaning:
  `connected` / `start` (carries `callSid`) / `media` (base64 → `Buffer`) /
  `stop`. Malformed frames parse to a nothing-happened result rather than
  throwing; one bad frame must not kill a live call.
- **`twiml.ts`** — builds the TwiML response as a string.
- **`currentCall.ts`** — the single "a call is live, and here is its session id"
  slot, plus how it ended. Thin, but it makes presence a first-class thing rather
  than a variable inside a route handler, and it is what `GET /v1/call` reads.

### New routes

- **`POST /twilio/voice?token=…`** → TwiML. The `wss://` stream URL is derived from
  the request's `Host` header, so there is no public-URL config to keep in sync
  with Fly.
- **`WS /twilio/stream?token=…`** → media frames in, alongside the existing
  `/stream` upgrade path.
- **`GET /v1/call?since=N`** → `{ active, reason?, events, seq }`, token-guarded
  like the other `/v1` routes. Presence and captions in one poll.

`GET /v1/call` is read-only and **never creates a session**. This is why the watch
cannot simply poll `/v1/audio`: that endpoint creates a session on first use, so a
watch polling for a call that has not started would spin up a Deepgram connection
for nothing.

### Call lifecycle

Each Twilio frame maps to one transition, and nothing else changes call state:

| Frame / event | Relay does |
|---|---|
| `connected` | nothing — Twilio's handshake |
| `start` | take `callSid` as the session id; `currentCall.begin(...)`; first `feed` creates the ephemeral session and its Deepgram connection |
| `media` | base64-decode, `feed` the bytes |
| `stop` | `currentCall.end("ended")`, `SessionStore.stop(sessionId)` |
| socket closes without `stop` | `currentCall.end("stream_lost")`, `SessionStore.stop(sessionId)` |

`SessionStore.stop` is what closes the Deepgram connection, so both endings must
call it or a dead call leaks an upstream socket. Because the session is ephemeral,
`stop` skips `transcripts.finalize` — no summary, no export.

A `start` arriving while a call is already current ends the old one first
(newest wins), so `currentCall` never holds a session that `SessionStore` has
already dropped.

### Config

- `TWILIO_FORWARD_TO` — the number `<Dial>` rings.
- `DEEPGRAM_PHONE_MODEL` — an env var rather than a hardcoded id, because the
  right model here is an open question worth answering with real calls.

Verified against Twilio and Deepgram docs on 2026-08-05:

- Twilio media payloads are `audio/x-mulaw` at `sampleRate` 8000, base64 in
  `media.payload`. Deepgram accepts `encoding=mulaw` with `sample_rate=8000`, so
  the no-transcoding claim holds.
- The `start` frame carries both `callSid` and `streamSid`, so using `callSid` as
  the session id is available at exactly the moment the lifecycle needs it.
- `<Start><Stream>` is confirmed non-blocking — Twilio "immediately continues with
  the next TwiML instruction" — so `<Dial>` runs while audio is already flowing.
- `inbound_track` is the default and means audio Twilio receives *from the other
  party*, which is the caller. Caller-only is confirmed as free.

**Model candidates, in the order worth trying:**

1. `phonecall` — the long-standing alias optimised for low-bandwidth phone audio.
   The safe baseline, and the default `DEEPGRAM_PHONE_MODEL` ships with. Verified
   against `@deepgram/sdk@3.13.0`: it only exposes `listen.live()` against the v1
   `:version/listen` endpoint. Confirmed against Deepgram's docs, this is a
   `nova`-family listen endpoint — `phonecall` fits it.
2. `flux-general-en` — Deepgram's conversational model built for voice agents and
   optimised for low latency, which is the number that decides this prototype —
   worth trying once the baseline works. **Not currently usable through this SDK
   version**: Flux is served by a separate v2 streaming API
   (`@deepgram/sdk@3.13.0` has no v2 listen client), so pointing
   `DEEPGRAM_PHONE_MODEL` at it would fail the first real call with a blank
   screen rather than transcribing anything. Trying it means either upgrading the
   SDK to a version with v2 support, or speaking that API directly — not a
   config-only change.
3. `nova-3` — best general accuracy; whether it has a telephony variant should be
   checked rather than assumed.

Trying more than one (within what the current SDK can reach) is the point of the
env var.

### `ProviderOptions` moves out of `server.ts`

`SessionStore` builds providers with `createProvider()` — **no arguments**. It
cannot express "this session is telephony audio", so a call routed through it would
get 16 kHz PCM settings and transcribe as noise.

So `SessionStore.getOrCreate` must accept provider options. That drags
`ProviderOptions` into `sessionStore.ts`, which today imports nothing from
`server.ts` — and `server.ts` imports `SessionStore`. Importing the type as-is
creates a cycle.

Fix: move `ProviderOptions` and `PROVIDER_NAMES` into their own module and
re-export from `server.ts` so no other call site changes. About ten lines. It also
closes a latent gap: today an HTTP session cannot request dual-channel or a
non-default provider the way a WebSocket one can.

## Watch

### Why not `SessionController`

Its job is permission → connect → ready → **start audio**. A call needs none of
them. A `.call` mode would be a branch that skips the main thing the class exists
to do.

A separate type is cleaner, and it has a property worth stating: the watch
**never touches the microphone or the audio session during a call**, so there is
nothing to contend with the call itself. That falls out of the structure rather
than needing care.

### New in CaptionCore

- **`CallClient`** — `poll(since:) async throws -> CallUpdate`, where
  `CallUpdate = { active, reason?, events, seq }`.
- **`decodeCallUpdate`** — response decoding, tested against real payload shapes,
  following `decodeTranscriptList`.
- **`CallCaptions`** — owns the poll loop, applies `ServerMessage`s to a
  `CaptionStore`, tracks whether the call has ended and why.

`CallCaptions` takes the `CaptionStore` as a dependency and writes into it exactly
as `SessionController` does, so `CaptionView` renders call captions unchanged. The
two are mutually exclusive by construction — a call session and a mic session are
never live at once.

### Getting in

`Route` gains `.call`. In `launch()`, after the existing
`guard !capturing, path.isEmpty` — so it cannot yank you out of a session you are
already in — the app asks the relay whether a call is live. If yes, straight to
call captions; if no, the existing launch action runs untouched. `launchAction`
stays a pure function; the network check sits around it in `AppModel`.

That check runs on every foreground, so it needs a **short timeout with
fall-through**: an unreachable relay must land you on the normal menu, not hang the
app open.

### When the call ends

`active: false` after having been active keeps the captions on screen with an ended
indicator rather than bouncing to the menu — you may still be reading the last
thing they said. You leave with the back chevron.

"Never was active" and "was active, now ended" are different states and the code
distinguishes them.

### Indicator

`CaptionView` takes `isLive: Bool` today. Four states now exist — recording,
live-only, on a call, call ended — so it becomes a small enum. Three call sites.

### Latency

Polling at 1 s, matching the existing transport. Expect roughly 1–2 s behind the
speaker once Deepgram's interim latency and the poll are stacked.

**This number decides whether the feature is usable**, and it is the first thing to
tune. It is deliberately not tuned up front: measuring one real call is worth more
than guessing.

## Failure modes

**Stream drops but the call continues.** Distinguishable: a `stop` frame means the
call ended; a socket close without one means the stream died under a live call.
`GET /v1/call` returns which, and the watch says *captions stopped* rather than
*call ended*. Showing "call ended" while you are still talking is a lie that would
make the screen untrustworthy.

**Relay down when a call arrives.** Twilio gets no TwiML and the caller hears a
failure. Fixed in the Twilio console rather than in code: set the number's
**fallback URL** to a static TwiML bin that only `<Dial>`s your phone. An outage
then degrades to a plain forwarded call instead of a dropped one.

**Deepgram fails.** Already handled — `DeepgramProvider` reconnects with backoff
and surfaces an error after repeated failure, which flows through the existing
event buffer to the watch.

**Poll fails mid-call.** Keep polling. A watch out of range is not the call ending,
the same reasoning as `ExportWatcher`.

**Wrist down mid-call.** watchOS suspends the app, polling stops, captions freeze
until you raise it again. Not fixable from here, and the most likely thing to make
this feel bad in practice — worth watching for specifically on the first real call.

## Accepted limits

Not bugs; deliberate omissions that do not change the prototype's answer:

- Newest call wins if two arrive at once.
- No reconnect if the media stream dies mid-call.
- The event buffer grows unbounded if you never look at your wrist during a long
  call (tens of KB — not worth capping yet).
- No Twilio signature validation; a `?token=` in the webhook and stream URLs
  instead, matching the relay's existing scheme. Both URLs live in the Twilio
  console, so they are not public — but anyone who learned the stream URL could
  feed audio in. Signature validation is the real answer and is deferred, not
  dismissed.
- No caller-ID display, no outbound calls, no call queueing.

## Testing

Unit tests for `twilioFrames` (including malformed input), `twiml`, and
`currentCall`. HTTP tests for `/twilio/voice` and `/v1/call` via the existing
`startServer` + `fetch` pattern in `server.transcripts.test.ts`.

The media-stream handler is driven with fake frames through a fake socket —
`StreamingSocketLike` and `FakeTranscriptionProvider` already exist for exactly
this — so **neither Twilio nor Deepgram appears in the test suite**.

On the watch: `CallCaptions` against a fake client (events reach the store, the
ended transition fires once, polling stops afterward, a thrown error does not end
the call) and `decodeCallUpdate` against real payload shapes.

Twilio itself is verified by making one real call.

## Setup (steps only you can do)

1. Twilio account, upgraded off trial.
2. Buy a number.
3. Voice webhook → `POST https://…/twilio/voice?token=…`
4. Fallback URL → a static TwiML bin that only `<Dial>`s your phone.
5. `fly secrets set TWILIO_FORWARD_TO=+1…`

Deploying to the main relay rather than a separate dev app: the routes are purely
additive and covered by tests.

## What this proves, and what happens next

A successful prototype answers one question — whether call captions are readable
and useful at roughly two seconds of lag on a 40 mm screen.

If yes, the next decisions are the ones deliberately skipped here: keeping your
real number (second line or companion app), both sides of the conversation with
attribution, saved transcripts with their consent implications, and signature
validation. Each is a real piece of work, and each is better decided with a real
call behind it.

If no, the cost was a few dollars and one endpoint to delete.
