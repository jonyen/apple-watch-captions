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

## Notion export (optional)

When `NOTION_TOKEN` and `NOTION_DATABASE_ID` are both set, each finished session
becomes a page in that database as two collapsed sections: a **Summary** toggle
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
