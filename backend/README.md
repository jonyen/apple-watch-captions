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

## Notion sync (optional)

When both env vars are set, every finished session's transcript (and its Claude
summary, if enabled) is created as a page in a Notion database:

```bash
NOTION_API_KEY=<integration secret> NOTION_DATABASE_ID=<database id> npm run dev
```

Setup:

1. Create an internal integration at [notion.so/my-integrations](https://www.notion.so/my-integrations)
   and copy its secret.
2. Create (or pick) a database for transcripts and connect the integration to it
   (database page → `...` → Connections).
3. The database id is the 32-char hex segment of its URL.

Each page gets a title like `2026-07-06 01:02 — first words of the session…`, a
**Summary** section when one was generated, and the full timestamped transcript.
A `<name>.notion.json` marker next to each transcript records the created page,
so nothing is synced twice.

To backfill transcripts recorded before Notion was configured (or after an
outage), run the same sync over the stored files:

```bash
NOTION_API_KEY=... NOTION_DATABASE_ID=... TRANSCRIPTS_DIR=./data/transcripts npm run sync:notion
```

On Fly: `fly secrets set NOTION_API_KEY=... NOTION_DATABASE_ID=...`

## Test

```bash
npm test          # full unit/integration suite (no API key needed)
```

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
