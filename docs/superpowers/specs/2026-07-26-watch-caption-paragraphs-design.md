# Resumed transcripts and flowing paragraphs

Two changes to how the watch presents a caption scroll.

1. Resuming a session shows the transcript it is resuming, instead of an empty screen.
2. Captions flow as paragraphs rather than one line per utterance, breaking only on a real pause.

## Problem

`CaptionStore.reset()` clears `lines` on every `start()`, resumes included. The relay
appends to the same transcript file, so the conversation continues on disk while the
screen starts blank — the one place the earlier context would be useful.

Separately, `CaptionView` renders each final caption as its own `Text` in a `VStack`.
Speech-to-text finalizes at utterance boundaries, so a paragraph of speech arrives as
five or six finals and reads as five or six stranded lines. On a watch-sized screen
that wastes most of the width and buries the pauses that actually matter.

## Detecting a pause

The obvious signal is wrong, and it is worth being explicit about why.

The gap between final *n* and final *n+1* is not a pause. A final arrives when the
provider decides an utterance is over, so that gap contains all of utterance *n+1*'s
speech. A single long sentence produces the same gap as a genuine silence, and any
threshold low enough to catch real pauses breaks on ordinary speech — leaving us
exactly where we started.

What *is* observable is silence. With `interim_results: true` the relay delivers
partials roughly once per poll while anyone is speaking, so **no caption traffic of any
kind for 3 seconds means genuine silence.** `CaptionStore` records the arrival time of
every caption message, partial or final. When a message arrives after a gap of at least
`livePauseThreshold`, it sets `pendingBreak`; the next final consumes the flag and
starts a new paragraph.

The deferral matters: the gap is observed by the *partial* that reopens speech, not by
the final that closes the new utterance. By the time that final arrives, partials have
already refreshed the arrival time. Deciding at observation time and consuming the
decision later is what makes this correct.

This needs no timer, no timing data from the provider, and no change to the relay
contract — so it works with Deepgram, AssemblyAI, and OpenAI alike.

Restored history has no traffic to observe. Its gaps come from the `at` timestamps
`transcriptStore.ts` already writes with every segment, against a more generous
`storedPauseThreshold`. Two signals, two numbers: an 8-second gap between stored finals
is unambiguous, where a 3-second one is not.

A channel change always breaks the paragraph, so `Me:` / `Them:` labelling stays
coherent on dual-channel transcripts.

### Thresholds

| Constant | Value | Applies to | Meaning |
| --- | --- | --- | --- |
| `livePauseThreshold` | 3s | live captions | no caption message of any kind arrived for this long |
| `storedPauseThreshold` | 8s | stored segments | gap between two stored finals' `at` timestamps |

## Components

### `CaptionCore/Paragraphs.swift` (new)

The shared, pure, testable core.

```swift
public struct CaptionParagraph: Identifiable, Equatable {
    public let id: UUID
    public let channel: Int?
    public var text: String
}

/// Group stored segments into paragraphs, breaking on a pause or a channel change.
public func buildParagraphs(
    from segments: [TranscriptSegment],
    pauseThreshold: TimeInterval = storedPauseThreshold
) -> [CaptionParagraph]
```

One join rule, used by both the stored path and the live path: append `" " + text` to
the last paragraph, unless there is no last paragraph, a break is pending, or the
channel differs — then start a new one.

### `CaptionStore`

`lines: [CaptionLine]` becomes `paragraphs: [CaptionParagraph]`, built incrementally
rather than recomputed. Only the last paragraph's text changes as captions arrive, so
SwiftUI re-lays-out one paragraph per update instead of the whole scroll.

- An injectable clock (`now: () -> Date`, defaulting to `Date.init`) so pause detection
  is testable.
- `apply(_:)` stamps every `.caption` with its arrival time, sets `pendingBreak` when
  the gap since the previous message reached `livePauseThreshold`, then folds the
  caption in.
- `prepend(_ segments: [TranscriptSegment])` builds paragraphs from stored segments and
  inserts them ahead of any existing ones. It sets `pendingBreak`, which keeps the
  first live caption from merging into the restored tail — a session boundary is by
  definition a long pause.
- `reset()` clears paragraphs, partials, `pendingBreak`, and the arrival stamp.

`CaptionLine` is removed. `partials` and `partial` are unchanged.

### `TranscriptSegment`

Gains `public let at: String?`, decoded from the `at` key that
`GET /v1/transcripts/<name>` already returns. The initializer defaults it to `nil` so
existing call sites are unaffected.

### `SessionController`

Gains an optional `history: HistoryClient?`. When `start(resuming:)` receives a name, it
launches a detached fetch of that transcript and hands the segments to
`store.prepend(_:)`.

The fetch is deliberately not awaited — the captions screen appears immediately and the
history fills in behind it. Before prepending it re-checks `running`, so a session
stopped mid-fetch does not repopulate a dead screen. Failures are swallowed: the session
is the point, it is already live, and an error banner over a working session would be
worse than missing scrollback.

It uses `HistoryClient` directly rather than `HistoryStore.loadDetail`, which writes the
shared `detail`/`detailState` the history screen renders from.

### `CaptionView`

`ForEach(store.paragraphs)` with paragraph spacing. The in-progress partial appends
inline to the current paragraph in secondary colour rather than occupying its own line:

```swift
Text(paragraph.text) + Text(" " + store.partial).foregroundStyle(.secondary)
```

With no paragraphs yet, the partial renders alone. Auto-scroll follows the last
paragraph's text and the partial.

### `TranscriptDetailView`

Renders `buildParagraphs(from: detail.segments)`. Because a channel change always starts
a new paragraph, the `Me:` / `Them:` prefix applies once per paragraph.

## Data flow

```
resume(name)
  ├─ controller.start(resuming: name) ─→ store.reset() ─→ relay.connect ─→ live captions
  └─ Task: history.detail(name) ─────────────────────────→ store.prepend(segments)
                                                             (sets pendingBreak)
```

Either branch may complete first. `prepend` inserts ahead of whatever is present, so
order does not matter.

## Out of scope

- **The Notion export.** It is a structured document, not a caption scroll, and keeps
  its per-segment blocks.
- **Relay and provider changes.** Pause detection is entirely client-side by design.

## Testing

In `CaptionCoreTests`:

- `buildParagraphs`: joins segments inside the threshold; breaks past it; breaks on a
  channel change; treats a missing or unparseable `at` as no break.
- `CaptionStore` with an injected clock: consecutive finals join; a final after 3s of
  no traffic starts a paragraph; a *partial* observing the gap still breaks the final
  that follows it; a channel change breaks; `prepend` inserts ahead of live paragraphs
  and prevents a merge in both arrival orders; `reset` clears the pending break.
- `SessionController` with a fake `HistoryClient`: a resume prefills; a new session does
  not; a fetch failure leaves the session running; a session stopped during the fetch
  does not get prefilled.

Pause detection depends on real speech timing and the relay's poll cadence, neither of
which the simulator reproduces, so the paragraph breaks and the inline partial are
verified by hand on the device.
