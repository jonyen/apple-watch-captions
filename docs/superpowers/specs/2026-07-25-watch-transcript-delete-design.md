# Deleting transcripts from the watch

## Problem

The watch's transcript list is read-only. Every session that produced a final
caption stays on the list forever — test runs, thirty-second accidents, sessions
whose summary went nowhere useful. There is no way to remove one without
shelling into the relay.

## What we're building

A swipe-left-then-tap-trash gesture on each row of `HistoryListView`, backed by
a new `DELETE /v1/transcripts/<name>` route on the relay.

The list is not local state — `HistoryStore` reads it from the relay through
`GET /v1/transcripts` — so a watch-only change would let deleted rows reappear
on the next refresh. The relay has to forget the transcript too.

## Scope of "delete"

A stored transcript is up to three files on the relay:

- `<name>.jsonl` — the captions
- `<name>.summary.md` — the generated summary, when one exists
- `<name>.notion.json` — the marker recording that it reached Notion

Deleting removes all three. **The Notion page is left alone.** The watch list is
a convenience view over the relay's disk; Notion is the durable archive, and it
is also the only undo path, since the watch offers none.

Dropping the `.notion.json` marker alongside the `.jsonl` is deliberate. The
export backfill sweep works from stored transcripts, so with the `.jsonl` gone
nothing can resurrect the entry.

## Backend

### `transcriptStore.ts`

```ts
export function deleteTranscript(dir: string, name: string): boolean
```

Guards with the existing `isSafeName` — the name is client-supplied and reaches
the filesystem. Returns `false` for an unsafe name, and `false` when
`<name>.jsonl` does not exist, so the route can answer 404. Otherwise unlinks
all three files, ignoring side files that were never written, and returns
`true`.

### `server.ts`

A `DELETE /v1/transcripts/<name>` branch in `handleRequest`, mirroring the GET
branch's guards in the same order:

| Condition | Response |
|---|---|
| `opts.transcriptsDir` unset | `404 {"error":"transcripts not enabled"}` |
| missing or bad `?token=` | `401 {"error":"unauthorized"}` |
| `deleteTranscript` returns false | `404 {"error":"not found"}` |
| otherwise | `200 {"deleted":"<name>"}` |

`DELETE /v1/transcripts` with no name is not a route — there is no bulk delete.

## CaptionCore

`HistoryFetching` is renamed to `HistoryClient` and gains a third method. A
protocol named "Fetching" that also deletes would read wrong, and there is
exactly one conformer (`RelayHistoryClient`) plus one test fake to update.

```swift
public protocol HistoryClient: Sendable {
    func list() async throws -> [TranscriptListItem]
    func detail(name: String) async throws -> TranscriptDetail
    func delete(name: String) async throws
}
```

`HistoryStore.delete(_ item: TranscriptListItem)` is optimistic:

1. Find the item's index in `items`; return if it is not there.
2. Remove it immediately, so the row animates out under the user's finger.
3. `try await client.delete(name:)`.
4. On error, re-insert at the captured index (clamped to the current count) and
   set `deleteError`.

`deleteError` is a new `@Published private(set) var deleteError: String?` with a
`clearDeleteError()` for the alert's dismissal.

`RelayHistoryClient.delete` issues the `DELETE` with the same `?token=` query
parameter the reads use, and maps a non-200 to `HistoryError.message` the same
way `get` does.

## Watch UI

`HistoryListView` attaches a swipe action to each row:

```swift
.swipeActions(edge: .trailing, allowsFullSwipe: false) {
    Button(role: .destructive) {
        Task { await history.delete(item) }
    } label: {
        Label("Delete", systemImage: "trash")
    }
}
```

`allowsFullSwipe: false` is load-bearing: a long swipe must not fire the delete
on its own. The gesture always ends on a deliberate tap of the trash icon.

Failures raise an alert bound to `deleteError`. Deleting the last row needs no
new code — the existing `.loaded where history.items.isEmpty` case already shows
"No transcripts yet".

## Testing

**`transcriptStore.test.ts`** — deletes all three files; succeeds when the
summary and marker were never written; returns false for an unknown name;
returns false for an unsafe name without touching the filesystem.

**`server.transcripts.test.ts`** — 200 and absent from the following list; 404
for an unknown name; 401 with no token and with a bad token.

**`HistoryStoreTests.swift`** — success removes the row; failure restores it at
its original index and sets `deleteError`.

## Accepted limitations

- **Deleting a live transcript.** A session still appending captions will
  recreate its `.jsonl` on the next final caption. Rare, and self-correcting.
- **No undo on the watch.** Recovery means the Notion page, which is why the
  Notion page survives.

## Out of scope

The Mac app reads transcripts through its own `RelayAPI` and is untouched.
Adding a route breaks nothing there; giving the Mac app its own delete
affordance is separate work.
