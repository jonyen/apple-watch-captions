# Watch Captions — Backend STT Relay

WebSocket service that relays a live PCM audio stream to Deepgram and streams
caption text back to the client.

## Protocol

- Connect: `ws://<host>:<port>/stream?token=<AUTH_TOKEN>`
- Send: binary frames of raw PCM — 16-bit signed little-endian, 16 kHz, mono.
- Receive (JSON text):
  - `{"type":"ready"}`
  - `{"type":"caption","text":"...","isFinal":true|false}`
  - `{"type":"error","message":"..."}`
- Clients MUST wait for `{"type":"ready"}` before sending audio; frames sent earlier are dropped.
- Bad token → connection closed with code `4001`.

## Run

```bash
cd backend
npm install
AUTH_TOKEN=dev-secret DEEPGRAM_API_KEY=<your-key> PORT=8080 npm run dev
```

## Test

```bash
npm test          # full unit/integration suite (no API key needed)
```

## Summaries (optional)

When a session ends, its transcript is summarized and stored next to it as
`<name>.summary.md`. Two backends are supported; pick with `SUMMARY_PROVIDER`,
or leave it unset and the relay uses whichever key is configured (Claude first).

| Provider | Env | Notes |
|----------|-----|-------|
| `claude` | `ANTHROPIC_API_KEY` | Better summaries; paid, though a full backlog costs cents. |
| `gemini` | `GEMINI_API_KEY` | Free tier at [aistudio.google.com](https://aistudio.google.com/apikey). **The free tier may use your inputs to improve Google's products; the paid tier does not.** Transcripts can hold sensitive material — choose deliberately. |

With neither key set, transcripts are still saved; only summaries are skipped.
Transcripts that never got a summary are picked up by a sweep on the next boot,
so fixing a key or switching providers backfills the gap without manual steps.

## Notion export (optional)

When `NOTION_TOKEN` and `NOTION_DATABASE_ID` are both set, each finished session
becomes a page in that database, named `2026-07-10 18:05 — <what it was about>`
(the summarizer writes the topic; sessions without a summary fall back to a plain
dated name). The page holds two collapsed sections: a **Summary** toggle
holding the Claude summary, and a **Full transcript** toggle holding every caption
line. The Summary toggle is omitted when no summary was generated. Set neither and
transcripts are still saved locally — only the export is skipped.

Setup:

1. Create an internal integration at
   [notion.so/my-integrations](https://www.notion.so/my-integrations) and copy its
   token (`ntn_…`).
2. Create the target database. The only required column is the title; add any of
   `Started` (date), `Ended` (date), `Segments` (number), `Session` (rich text)
   and the exporter fills them too. Columns it doesn't recognize are left alone.
3. **Share the database with the integration** — open it, `⋯` → *Connections* →
   add the integration. Skipping this is the usual cause of a `404` at export.
4. Copy the database id from its URL: `notion.so/<workspace>/<database-id>?v=…`.
5. Check it before deploying:
   ```bash
   node scripts/notion-check.mjs <token> <database-id>
   ```
   It reports whether the database is reachable and which columns will be filled.
6. Set the secrets:
   ```bash
   fly secrets set NOTION_TOKEN="ntn_…" NOTION_DATABASE_ID="<database-id>"
   ```

### Resuming a session

`POST /v1/audio?session=<id>&resume=<transcriptName>` binds a new session to an
existing transcript, so its captions append there instead of opening a new file.
When that session ends, the summary is regenerated over the combined transcript
and the existing Notion page is updated in place: the stale Summary toggle is
replaced, only the new caption lines are appended, and the page is retitled.

The export marker records `exportedSegments`, which is what keeps a resumed
session from duplicating lines already on the page. Markers written before this
existed count as zero, so their next update re-appends from the start — a
one-time duplication on already-exported pages, not an ongoing one.

Sessions are finalized after **10 minutes** without audio (was 15 seconds), so
lowering your wrist mid-conversation no longer ends the session.

### Live sessions

`POST /v1/audio?session=<id>&ephemeral=1` streams captions back as usual but
persists nothing: no transcript file, so no summary and no Notion page. The
response carries no `transcript` name, because there is none to resume into, and
`resume=` is ignored.

The flag is fixed when the session is created. A later post that drops it does
not start saving, and one that adds it does not stop — a conversation cannot
change what it does with what it hears half way through.

Behavior worth knowing:

- **Exports are recorded.** A successful export writes `<name>.notion.json` next
  to the transcript. Nothing with a marker is exported again, so no duplicate
  pages.
- **Missing summaries are backfilled.** On every boot the relay summarizes any
  stored transcript that has no `<name>.summary.md` — sessions that ended while
  `ANTHROPIC_API_KEY` was unset, out of credit, or erroring. If that transcript
  was already exported, its existing Notion page gets the Summary toggle added
  in place rather than a duplicate page (the toggle lands after the transcript
  there, since Notion's append API has no prepend).
- **Failures retry.** A failed export leaves no marker; the relay sweeps for
  unmarked transcripts on every boot and exports them oldest-first. That same
  sweep backfills history from before the integration was configured.
- **Very short sessions are skipped** (under 40 characters), matching the rule
  that already governs summaries.
- The export never blocks captions or transcript storage — it runs after the
  session's transcript is safely on disk.

## Manual smoke test (needs a real Deepgram key)

Streams a 16 kHz mono PCM file to the running server and prints captions.

1. Start the server (see Run).
2. Create a test PCM file from any audio with ffmpeg:
   ```bash
   ffmpeg -i sample.mp3 -ac 1 -ar 16000 -f s16le sample.pcm
   ```
3. Run the smoke test:
   ```bash
   node scripts/smoke-test.mjs ws://127.0.0.1:8080/stream dev-secret sample.pcm
   ```
   Expected: a stream of `caption` lines ending with finalized text matching the audio.
