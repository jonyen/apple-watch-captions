# Watch sessions and history — design

**Date:** 2026-07-25
**Status:** approved; phase 1 in progress

## Problem

Two settings interact badly. The watch app stops capturing on `.background` —
which fires when you lower your wrist — and the relay finalizes a session after
15 seconds idle (`sessionStore.ts`, `idleTimeoutMs`). Every wrist-down/raise
cycle therefore ends the session and starts a fresh UUID, shattering one
conversation across several transcripts. The stored data shows it: session id
`11477643` appears under both `15-39-41Z` and `16-06-47Z`, and six of the
twenty-one transcripts are 3–34 character fragments.

There is also no way to read a transcript or summary on the watch at all; they
are only visible at `/app` or in the mac app.

## Goals

1. Resume recording into an existing transcript, so one conversation stays one
   transcript.
2. Browse past transcripts and summaries on the watch.
3. Notion page titles that say what the recording was about, not just when.

## Non-goals

- Editing or deleting transcripts from the watch.
- Offline capture. The relay remains required.

---

## Phase 1 — Titles

The summarizer emits a title as the first line of its output:

```
Title: Vendor call with CodeRabbit about AI code review

An overview sentence...
- bullets
```

`parseSummary(raw)` splits that into `{ title?, body }`. The raw text (title line
included) stays in `<name>.summary.md`; parsing happens at read time, so
summaries written before this change simply parse to `title: undefined` and keep
working.

Consumers:

- **Notion title property:** `2026-07-10 18:05 — <title>`, falling back to the
  current `Captions <date> <time> UTC` when no title is available.
- **Notion Summary toggle:** body only — the title line is not repeated inside.
- **Viewer and mac app:** unchanged; they render the file as-is.

The fifteen existing pages get hand-written titles applied via
`PATCH /v1/pages/{id}`, rather than a re-summarize run.

## Phase 2 — Resume

**Wire format:** `POST /v1/audio?session=<newId>&resume=<transcriptName>`. The
transcript name is the stable identity across summary files, export markers, and
Notion pages; session ids are not (they already map to multiple files).

**TranscriptStore** gains `reopen(sessionId, name)`: appends continue into the
existing `.jsonl` instead of opening a new one, and the finalized transcript is
flagged as resumed.

**Export marker** gains `exportedSegments: number` and `summaryToggleId: string`.
On re-finalize where a marker exists:

1. Regenerate the summary over the combined transcript.
2. Delete the stale Summary toggle, append a fresh one.
3. Append only segments past `exportedSegments`, so re-stopping never duplicates
   lines.
4. Update the page title, since the topic may have moved on.

Summaries always regenerate on re-finalize. A summary that silently stops
matching its transcript is the same failure class that hid the billing outage
this session, so staleness is not an accepted state.

**Idle window** widens from 15 seconds to 10 minutes, matching the auto-resume
window below. Otherwise a resumed session finalizes and re-summarizes between
every glance at the wrist.

## Phase 3 — Watch UI

`RelayHistoryClient` calls the two endpoints that already exist —
`GET /v1/transcripts` and `GET /v1/transcripts/<name>` — so browsing needs no new
backend surface.

In `CaptionCore` (pure logic, unit-tested, matching the existing package split):

- `HistoryStore` — list and detail state.
- `ResumeDecision` — the launch rule, as a pure function over "last transcript
  name" and "ended at".

Views: `HomeView` (New / Continue / Browse), `HistoryListView`,
`TranscriptDetailView` (summary, then caption lines).

**List row layout:** the title is the primary line, with the date as a smaller
subheading beneath it — the topic is what you scan for, the date only
disambiguates. Rows for sessions with no summary fall back to the dated name as
the primary line with no subheading.

To support that, `GET /v1/transcripts` returns a parsed `title` per entry
alongside the existing fields.

**Launch rule:** if the last session ended less than 10 minutes ago, resume it
silently — glancing away costs nothing. After a longer gap, land on `HomeView`.
Last transcript name and end time persist in `UserDefaults`.

An explicit **Stop** control is added, since lowering your wrist no longer ends a
session.

## Testing

`CaptionCore` holds the logic and is unit-testable without a watch: history
state, the resume decision, and title parsing all get tests. Backend changes —
`reopen`, re-export accounting, title parsing — are covered by vitest, with the
Notion API faked as it already is in `notionExporter.test.ts`.

## Build order

Each phase is independently shippable, in this order: titles, then resume, then
the watch UI (which depends on resume).
