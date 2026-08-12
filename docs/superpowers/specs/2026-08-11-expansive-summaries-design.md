# Expansive summaries: give the model room, then ask it for structure

## Problem

Transcript summaries are too thin. Four complaints, all real:

- **Too short overall.** A one-or-two sentence overview and a few bullets, whatever
  the recording.
- **Loses specifics.** Names, numbers, dates, and decisions get compressed away.
- **Missing structure.** Flat overview-plus-bullets regardless of content, so a long
  recording has no navigable shape.
- **Doesn't cover the whole recording.** The beginning is well covered; the rest
  thins out or drops.

The first three are the prompt. The fourth is partly mechanical, and that part is
worth stating plainly because it would survive any prompt rewrite.

## The token ceiling is doing more damage than the prompt

`summarizer.ts` sets `max_tokens: 2048` alongside `thinking: { type: "adaptive" }`.
On Opus 4.8 `max_tokens` bounds thinking *and* response text together — so the
summary competes with the model's own reasoning for a 2048-token budget. A long
transcript is exactly the case where thinking grows, which is exactly when the
summary gets squeezed.

Worse, nothing notices:

```ts
const block = response.content.find((b) => b.type === "text");
return block?.type === "text" ? block.text : "";
```

`stop_reason` is never read. A summary that hit the ceiling is stored as though it
were complete, and because `<name>.summary.md` is the done-marker, the backfill
sweep will never revisit it. A truncated summary is permanent.

The Gemini path sets no output limit at all. So the two providers already produce
different lengths from the same prompt — Claude clipped at 2048, Gemini running to
its own default.

| Symptom | Cause |
|---|---|
| Summaries thin out on long recordings | Thinking + text share a 2048-token ceiling |
| Truncation is permanent | `stop_reason` unchecked; summary file is the done-marker |
| Providers disagree on length | Claude capped, Gemini uncapped |

## Design

### One summary, shown everywhere

No tiering. The watch, the viewer page, and Notion all render the same stored
summary. A short overview for the wrist plus a long body for Notion was considered
and rejected: it doubles the generation, storage, and parsing paths to save
scrolling on a screen that already scrolls.

### Shape: topic sections, depth scaling with length

```
Title: <short title>

<overview paragraph>

## <topic>
<detail, preserving names, numbers, dates, decisions>

## <topic>
...

## Action items
- ...
```

Section count grows with the recording rather than being fixed, which is what
addresses uneven coverage on the prompt side. The `Title:` first line is unchanged —
`parseSummary` depends on it and is already covered by `summaryPrompt.test.ts`.

`SUMMARY_SYSTEM_PROMPT` is shared by both summarizers, so this is a single edit that
moves Claude and Gemini together.

### Token budget

`max_tokens` goes to **16000** — the documented default for non-streaming requests,
chosen because it stays under SDK HTTP timeouts and needs no conversion to
`.stream()`. Opus 4.8 supports up to 128K, but reaching for it would mean rewriting
the call as a stream for output lengths this feature does not need.

Gemini gets an explicit `maxOutputTokens: 16000` so the two providers agree.

`summarizer.ts` treats `stop_reason === "max_tokens"` as a failure and throws.
Both call sites already handle a throwing summarizer, and both leave the work
retryable:

- `backfillSummaries` catches, logs, counts `failed`, and continues to the next
  transcript.
- `finalizeSession` catches, logs, and still exports the transcript to Notion
  without a summary — the same path taken when no API key is configured.

Neither writes `<name>.summary.md`, so the next boot sweep retries the transcript.
A truncated summary therefore becomes a retry instead of a permanent artifact,
which is the whole point of the change.

### Watch rendering

`TranscriptDetailView.swift` renders the summary with `Text(summary)` where
`summary` is a `String`. That overload does not parse markdown, so today's `- `
bullets already display literally; adding `##` headings would make it worse.

Fix at the render site: parse to `AttributedString` with the markdown initializer,
falling back to the plain string if parsing throws. No storage-format change, and
summaries written before this ship keep working.

### Regeneration

Everything stored today was written under the old prompt, so the archive needs a
pass. Three constraints shape it:

1. `backfillSummaries` skips any transcript that already has a summary — the file
   *is* the marker. Regeneration needs a `force` mode; a re-run alone does nothing.
2. `runBackfills()` executes on **every server boot**. Regeneration must not go
   there, or every Fly.io restart re-summarizes the whole archive and bills for it.
3. Notion needs nothing new: `createNotionUpdater` already deletes the existing
   summary toggle and rewrites it.

So: `backfillSummaries` gains `force?: boolean`, and the existing
`listTranscripts(dir).reverse()` already yields newest-first, which the existing
`limit` bounds. A separate `npm run resummarize -- --last N` entrypoint drives it,
outside the boot path. The script reports how many transcripts match before
spending anything.

`--last N` is **required**: invoked without it the script exits non-zero and prints
usage rather than defaulting to the whole archive. Regenerating everything is a
real thing to want, but it should be spelled `--last 9999` deliberately, not
reached by forgetting a flag. `force` defaults to `false`, so every existing
caller — `runBackfills()` above all — keeps today's skip-if-summarized behavior
with no change.

## Testing

Follows the existing suites — `summaryPrompt.test.ts` and `summaryBackfill.test.ts`
both exist and already inject fakes.

| Test | Asserts |
|---|---|
| Prompt shape | The system prompt names its sections and the `Title:` contract |
| `parseSummary` unchanged | Existing title-parsing tests still pass against the new body shape |
| Truncation guard | A `stop_reason: "max_tokens"` response throws rather than returning text |
| Backfill default | Without `force`, transcripts with summaries are still skipped |
| Backfill force | With `force` and `--last N`, exactly the newest N regenerate |
| Backfill bounds | Transcripts outside the N are untouched on disk |

## Out of scope

- **Model migration.** The repo is on `claude-opus-4-8`; `claude-opus-5` is current.
  That migration carries its own prompt re-tuning and belongs on its own branch.
- **Tiered summaries.** Rejected above.
- **Viewer page layout.** `viewerPage.ts` renders whatever it is given; the richer
  markdown needs no change there.
