# Live caption: captions without a transcript

## Problem

Every watch session is recorded. Tapping "New session" streams audio to the relay,
which writes a JSONL transcript, summarizes it, and exports it to Notion. Sometimes
that is the point. Sometimes you only want to read what the person across the table
just said, and a permanent record of it is worse than useless — it is clutter you
have to go delete.

"Live caption" is the second door: captions on the screen, nothing kept anywhere.

## Where "not saved" has to happen

The watch does not persist transcripts; the relay does. `TranscriptStore.append`
creates the file on the first final caption, and `finalize` fires the `onFinalize`
hook that drives the summarizer and the Notion export. So the watch cannot opt out
of saving on its own — the decision belongs to the relay, and the watch's job is to
declare its intent.

Two alternatives were considered and rejected:

- **Save, then delete on stop.** The watch would call `DELETE /v1/transcripts/:name`
  when the session ends. No backend change, but the file exists mid-session, the
  summarizer and Notion export still fire on finalize, and a session that ends by
  crash, reap, or a backgrounded app leaves the transcript behind. "Usually not
  saved" is not the feature.
- **Save but hide from the Transcripts screen.** Cheapest of all, and it still
  saves. Wrong feature.

## Relay: ephemeral sessions

The watch adds `&ephemeral=1` to its `/v1/audio` posts.

The flag is **sticky at session creation**, mirroring how `resume` already works.
`SessionStore.feed(id, pcm, ephemeral)` passes it to `getOrCreate`, which records it
on the `Session`. Later posts carry the param but cannot change it, so no
mid-session request can turn a live session into a saved one or the reverse.

Everywhere `SessionStore` touches `transcripts`, it checks the flag:

- the caption callback in `getOrCreate` skips `transcripts.append`, so **no file is
  ever created** — `append` is what creates it
- `stop`, `reapIdle`, and `closeAll` skip `transcripts.finalize`, so there is **no
  `onFinalize` hook, no summary, and no Notion export**

`/v1/audio` also skips `transcripts.reopen` for an ephemeral session, and omits
`transcript` from its response. `activeName` would return `undefined` anyway; being
explicit keeps the contract legible.

Captions still stream back exactly as before, and Deepgram usage still counts. You
pay for the speech-to-text either way; you just do not keep the text.

The mac app's WebSocket path (`streamingSocket.ts`) is untouched. This is
watch-only.

## Watch

### CaptionCore: make "live and resuming" unrepresentable

A live session can never resume — there is no transcript to append to. A `Bool`
beside `resuming:` would admit a state that does not exist, so the mode is one
enum instead:

```swift
public enum SessionMode: Equatable {
    /// The relay persists captions; `resuming` appends to an existing transcript.
    case saved(resuming: String?)
    /// Captions reach the screen and nowhere else.
    case live
}
```

`Relay.connect(resuming:)` becomes `connect(mode:)`. `HTTPRelayClient` derives both
`resumeName` and the `ephemeral=1` query item from the mode.

`SessionController.start(resuming:)` becomes `start(mode:)`. `restorePreviousTranscript`
is reachable only from `.saved(resuming: name)`, which makes the exclusion structural
rather than a guard someone can forget.

### AppModel

`startLive()` clears `currentTranscript` and calls `controller.start(mode: .live)`.
A published `live` flag drives the on-screen cue and resets in `endCapture()`.

Because the relay never names a transcript for an ephemeral session,
`currentTranscript` stays nil and `rememberCurrentSession()` is already a no-op —
but it gets an explicit `live` guard rather than leaning on that coincidence.

### Leaving a live session ends it

A live session has nothing to resume into, so leaving it — back-swipe, screen
sleep, app background — ends it. `lastSession` is left pointing at your last *saved*
session, and relaunching lands on the menu.

That last part requires setting `stoppedExplicitly = true` when a live session ends.
Otherwise `launchAction` could auto-resume whatever saved session you had been in
before the live one, which would read as the app ignoring what you just did. The
cost: that earlier saved session stops auto-resuming too. It is still there under
"Continue last" — you tap it instead of being dropped into it. That is the honest
reading of "ends for good."

### Views

**`HomeView`.** The first list row holds an `HStack` of two buttons rather than one:
`New session` keeps its `mic.fill` label and expands to fill, and `Live caption` is
a fixed-width `waveform` icon button beside it.

```
+--------------------------+-----+
|  (mic)  New session      | ~~~ |
+--------------------------+-----+
+--------------------------------+
|  (arrow) Continue last         |
+--------------------------------+
+--------------------------------+
|  (list)  Transcripts           |
+--------------------------------+
           v1.4 (312)
```

Both buttons need an explicit `.buttonStyle(.bordered)`: a bare `Button` in a
watchOS list row expands to the full width, and two of them would fight over it.

Width is the risk. A 41mm row leaves roughly 130pt usable, so a 40pt live button
leaves about 85pt for "New session" plus its mic glyph — tight enough that the label
will probably truncate. The wide button gets `minimumScaleFactor(0.8)`, and this is
verified on the 41mm simulator before it ships. If it still truncates, the mic glyph
goes rather than the words.

The icon-only button carries `accessibilityLabel("Live caption")` and a hint that
nothing is saved.

**`CaptionView`.** Takes an `isLive` flag and swaps the existing 7pt top-trailing
dot for `Circle().strokeBorder(.green, lineWidth: 1.5)` — filled means recording,
hollow means live-only. Same position, same size, no extra chrome on a small screen.
The ring is invisible to VoiceOver on its own, so the indicator gets an
accessibility label: "Live only, not saved" against "Recording".

## Testing

**Backend (vitest).** An ephemeral session writes no file and fires no `onFinalize`.
A saved session is unchanged. The flag is sticky: a second post *without*
`ephemeral=1` still does not save. The `/v1/audio` response omits `transcript`.

**CaptionCore (swift-testing).** `.live` never calls `history.detail`. The fake relay
records the mode it was handed, so `startLive` reaching the transport is asserted
rather than assumed.

**By hand.** The views have no test target in this repo, so the split row and the
hollow dot are checked on the watch. Per prior experience, gesture automation does
not work on the watchOS simulator, so the taps are manual.

## Out of scope

- Any live-caption equivalent on the mac app.
- Converting a live session into a saved one mid-conversation. If you decide you
  wanted a record, you start a new session; the audio already streamed is gone.
- Retention or expiry policy for saved transcripts. Unchanged.
