# Deploying the STT Relay to Fly.io

The service runs via `tsx` (see README). Fly builds the `Dockerfile` and runs it.
Config lives in `fly.toml`. The two secrets (`AUTH_TOKEN`, `DEEPGRAM_API_KEY`) are NOT in
git — they are set with `fly secrets`.

## Prerequisites

1. A Fly.io account and `flyctl` installed (`brew install flyctl`).
2. A Deepgram API key — sign up at https://console.deepgram.com and create a key
   (the free credit covers this usage).

## One-time setup

```bash
cd backend

# 1. Log in to Fly (opens a browser).
fly auth login

# 2. Create the app from the existing fly.toml. If the app name is taken,
#    edit `app = "..."` in fly.toml to something unique, then re-run.
fly apps create watch-captions-relay

# 3. Generate a strong auth token and set both secrets.
AUTH_TOKEN=$(openssl rand -hex 32)
echo "Save this token — the Watch/iOS app will use it: $AUTH_TOKEN"
fly secrets set AUTH_TOKEN="$AUTH_TOKEN" DEEPGRAM_API_KEY="<your-deepgram-key>"

# 4. Create the volume that stores transcripts (mounted at /data, see fly.toml).
fly volumes create transcripts --size 1

# 5. (Optional) Enable transcript summaries — set an Anthropic API key.
#    Without it, transcripts are still saved; only summaries are skipped.
fly secrets set ANTHROPIC_API_KEY="<your-anthropic-key>"

# 6. (Optional) Email a "transcript ready" notification when a session ends.
#    Reuses the same Gmail app-password account as the weekly usage report
#    (the MAIL_USERNAME / MAIL_PASSWORD GitHub secrets — set them here too).
fly secrets set MAIL_USERNAME="<gmail-address>" MAIL_PASSWORD="<gmail-app-password>" \
  NOTIFY_EMAIL_TO="<where-to-send>"
```

## Deploy

```bash
cd backend
fly deploy
```

When it finishes, your relay is at:

```
wss://<app-name>.fly.dev/stream?token=<AUTH_TOKEN>
```

(e.g. `wss://watch-captions-relay.fly.dev/stream?token=...`)

## Verify the live deployment

```bash
# Health check (should print: ok)
curl https://<app-name>.fly.dev/healthz

# Full transcription smoke test (needs a 16kHz mono PCM file — see README):
node scripts/smoke-test.mjs wss://<app-name>.fly.dev/stream "$AUTH_TOKEN" sample.pcm
```

## Transcripts & summaries

- Final captions are appended per-session as JSONL under `/data/transcripts` on the
  volume; a markdown summary is generated with Claude when a session ends (if
  `ANTHROPIC_API_KEY` is set).
- View them in a browser at `https://<app-name>.fly.dev/app` (paste the `AUTH_TOKEN`
  once; it is kept in the browser's localStorage).
- JSON API: `GET /v1/transcripts?token=...` and `GET /v1/transcripts/<name>?token=...`.
- With the mail secrets set, each finished session emails `NOTIFY_EMAIL_TO` its summary
  and a link to the viewer. The viewer link uses `https://$FLY_APP_NAME.fly.dev`
  automatically; override with a `PUBLIC_URL` env var if you front it with a custom
  domain. Sessions with almost no speech are skipped. Email timestamps use the `TZ`
  set in `fly.toml`.

## Notes

- `auto_stop_machines = "off"` + `min_machines_running = 1` keep the relay always up so it
  can accept incoming connections. This is the ~$2–5/month fixed cost from the design spec.
- Weekly cost/usage monitoring (Deepgram + Fly, posted as a GitHub issue every
  Monday) is set up in [MONITORING.md](./MONITORING.md).
- To view logs: `fly logs`. To update after code changes: `fly deploy` again.
- Rotate the auth token any time with `fly secrets set AUTH_TOKEN=<new>` (then update the app).
