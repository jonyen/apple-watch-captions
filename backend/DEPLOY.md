# Deploying the STT Relay to Fly.io

The service runs via `tsx` (see README). Fly builds the `Dockerfile` and runs it.
Config lives in `fly.toml`. Secrets — `DEEPGRAM_API_KEY` and (optionally)
`ADMIN_TOKEN` — are NOT in git; they are set with `fly secrets`. There is no
`AUTH_TOKEN`: devices authenticate by self-registering with `POST /v1/devices`
and getting their own bearer token back — see backend/README.md
"Authentication".

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

# 3. Set the Deepgram key. There is no relay-wide auth secret to generate —
#    devices self-register at runtime and get their own token.
fly secrets set DEEPGRAM_API_KEY="<your-deepgram-key>"

# 3a. (Optional) Set an admin token that gates GET /v1/usage — the
#     operator-only cost/usage endpoint. Without it, /v1/usage stays closed.
ADMIN_TOKEN=$(openssl rand -hex 32)
echo "Save this — it's what you'll pass to GET /v1/usage: $ADMIN_TOKEN"
fly secrets set ADMIN_TOKEN="$ADMIN_TOKEN"

# 4. Create the volume that stores transcripts (mounted at /data, see fly.toml).
fly volumes create transcripts --size 1

# 5. (Optional) Enable transcript summaries — set an Anthropic API key.
#    Without it, transcripts are still saved; only summaries are skipped.
fly secrets set ANTHROPIC_API_KEY="<your-anthropic-key>"

# 6. (Optional, deprecated) Seed one user's Notion connection from an
#    existing single-workspace setup — it does NOT export on its own; every
#    export reads a user's own connection made via #7 below, with no
#    fallback to this. Verify access first — a 404 here means the database
#    isn't shared with the integration. Prefer #7 for a real deployment; see
#    backend/README.md "Legacy single-workspace Notion export" for exactly
#    when this gets read (only onto the relay's one user, if there is
#    exactly one).
node scripts/notion-check.mjs "<ntn_token>" "<database-id>"
fly secrets set NOTION_TOKEN="<ntn_token>" NOTION_DATABASE_ID="<database-id>"

# 7. (Optional) Let each user connect their own Notion workspace and/or
#    email address from /app/exports, instead of #6's one shared workspace.
#
#    7a. The master key sealing stored Notion tokens at rest. Required for
#        any of this — without it, /app/exports has nothing to connect.
ENCRYPTION_KEY=$(openssl rand -base64 32)
fly secrets set ENCRYPTION_KEY="$ENCRYPTION_KEY"

#    7b. This deploy's own public origin — the OAuth redirect and the emailed
#        confirmation link both point back at it. Not a secret; goes in
#        fly.toml's [env], already set there to the app's default `fly.dev`
#        hostname — edit it there if you're using a custom domain instead.
#
#    7c. A public Notion integration (Type: Public, not the Internal one used
#        by #6) — see backend/README.md "Registering the Notion integration"
#        for the redirect URI it needs and where to find these.
fly secrets set NOTION_CLIENT_ID="<client-id>" NOTION_CLIENT_SECRET="<client-secret>"

#    7d. Resend, for the email export destination — an API key (secret) and
#        the From address (not a secret; also in fly.toml's [env], edit it
#        there). See https://resend.com.
fly secrets set RESEND_API_KEY="<resend-api-key>"
```

## Deploy

```bash
cd backend
fly deploy
```

When it finishes, your relay is at `wss://<app-name>.fly.dev/stream`
(e.g. `wss://watch-captions-relay.fly.dev/stream`). Each app registers its own
device and token against it on first launch — see backend/README.md
"Authentication" — there's no fixed connection URL with a baked-in token
anymore.

## Verify the live deployment

```bash
# Health check (should print: ok)
curl https://<app-name>.fly.dev/healthz

# Register a device to get a token:
curl -X POST https://<app-name>.fly.dev/v1/devices -d '{"kind":"mac"}'

# Full transcription smoke test (needs a 16kHz mono PCM file — see README):
node scripts/smoke-test.mjs wss://<app-name>.fly.dev/stream "<device-token>" sample.pcm
```

## Transcripts & summaries

- Final captions are appended per-session as JSONL under a per-user directory
  in `/data/transcripts` on the volume; a markdown summary is generated with
  Claude when a session ends (if `ANTHROPIC_API_KEY` is set).
- The users/devices/pairing-codes database lives at `DB_PATH` (defaults to
  `/data/transcripts/identity.db`, so it rides the same volume).
- View them in a browser at `https://<app-name>.fly.dev/app` (paste a device
  token once; it is kept in the browser's localStorage).
- JSON API: `GET /v1/transcripts?token=...` and `GET /v1/transcripts/<name>?token=...`
  — with the calling device's own token, scoped to that device's account.
- Old installs: unset the retired mail secrets with `fly secrets unset MAIL_USERNAME MAIL_PASSWORD NOTIFY_EMAIL_TO`.
- Pre-existing installs: any transcripts written before the relay had
  accounts are adopted into a fresh user on first boot of this version, with
  the adoption token logged once (`fly logs`) — see backend/README.md
  "Authentication".

## Notes

- `auto_stop_machines = "off"` + `min_machines_running = 1` keep the relay always up so it
  can accept incoming connections. This is the ~$2–5/month fixed cost from the design spec.
- `PUBLIC_BASE_URL` and `EMAIL_FROM` live in `fly.toml`'s `[env]` too, right
  beside `TRUST_PROXY_HEADERS` — neither is a secret (a deploy's own public
  address; a From address), unlike `NOTION_CLIENT_SECRET` and
  `RESEND_API_KEY`, which are credentials and belong only in `fly secrets`.
  Edit `PUBLIC_BASE_URL` in `fly.toml` if you're on a custom domain rather
  than the default `fly.dev` hostname.
- `TRUST_PROXY_HEADERS = "true"` in `fly.toml`'s `[env]` is what makes the
  registration rate limit work on Fly: `http_service` terminates the client's
  connection, so without it every caller shares one 10-per-hour bucket and any
  ten registrations would close registration — the only way to get a device
  token — for everyone, for an hour. Only ever set it where a proxy
  **overwrites** `Fly-Client-IP` on the way in (Fly's edge does). If you run
  this relay anywhere the port is reachable directly, unset it: the header is
  caller-supplied there, and trusting it removes the limit entirely. See
  backend/README.md "Rate limiting".
- Weekly cost/usage monitoring (Deepgram + Fly, posted as a GitHub issue every
  Monday) is set up in [MONITORING.md](./MONITORING.md).
- To view logs: `fly logs`. To update after code changes: `fly deploy` again.
- Rotate the admin token any time with `fly secrets set ADMIN_TOKEN=<new>`. Per-device
  tokens have no rotation command — re-registering (`POST /v1/devices`) mints a new one
  for that device.
