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
