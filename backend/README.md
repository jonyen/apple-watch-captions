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

### Knowing when an export lands

`GET /v1/transcripts/<name>/export` answers `{"exported": false}` while the page
is still being written, then `{"exported": true, "url": …, "title": …,
"exportedAt": …}`. The watch polls it after a session ends so it can notify you
once the transcript is in Notion — nothing exists to link to at the moment you
tap Stop, since the summary and the export both run after the session closes.

Separate from the transcript detail endpoint on purpose: polling that would ship
every caption back over a cellular watch link on each attempt.

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

## Call captioning (optional, prototype)

Reads a live phone call onto the watch: a caller dials a Twilio number, Twilio
forks their audio to this relay for captioning and bridges the call to your real
phone, and the watch polls `GET /v1/call` for what was said. See
`docs/superpowers/specs/2026-08-05-twilio-call-captioning-design.md` for the full
design and its reasoning.

| Env | Required | Notes |
|-----|----------|-------|
| `TWILIO_FORWARD_TO` | Yes, to enable `/twilio/voice` | The number `<Dial>` rings — your real phone, in `+1…` form. Without it, `/twilio/voice` answers `503` rather than TwiML that dials nowhere. |
| `DEEPGRAM_PHONE_MODEL` | No | Overrides the Deepgram model used for call audio. Defaults to `phonecall`, the safe telephony baseline — see the spec's "Model candidates" for why `flux-general-en` is not currently reachable through this relay's SDK version. |
| `CALL_WAIT_ATTEMPTS` | No | How many ringback rounds the caller hears before the call falls back to `TWILIO_FORWARD_TO`. Roughly four seconds each, so the default `5` is about twenty seconds of ringing. Must be a whole number, 1 or more; anything else is ignored with a warning rather than booting on a budget that would skip the ring entirely. |

Setup (Twilio console; nothing else in this repo needs to change):

1. Create a Twilio account and get off the trial — trial accounts restrict
   outbound calls to verified numbers and play a notice on every call.
2. Buy a phone number.
3. Set its **Voice webhook** to `POST https://<your-relay-host>/twilio/voice?token=<AUTH_TOKEN>`.
4. Set its **fallback URL** to a static TwiML bin that only `<Dial>`s your real
   phone. This is the entire mitigation for the relay being down when a call
   arrives: with no fallback, Twilio gets no TwiML and the caller hears a
   failure; with it, an outage degrades to a plain forwarded call instead of a
   dropped one.
5. `fly secrets set TWILIO_FORWARD_TO=+1…`

Call sessions are ephemeral by design — no transcript file, no summary, no
Notion export. Transcribing a call is recording it in most two-party-consent
jurisdictions, and nothing here should quietly accumulate recordings of people
who never agreed to one.

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
