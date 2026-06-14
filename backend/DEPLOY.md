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

## Notes

- `auto_stop_machines = "off"` + `min_machines_running = 1` keep the relay always up so it
  can accept incoming connections. This is the ~$2–5/month fixed cost from the design spec.
- To view logs: `fly logs`. To update after code changes: `fly deploy` again.
- Rotate the auth token any time with `fly secrets set AUTH_TOKEN=<new>` (then update the app).
