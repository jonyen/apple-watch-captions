# Deploying the STT Relay

## Current deployment reality (as of 2026-08-24)

The relay now runs on the user's iMac, `ring`, reachable over Tailscale —
**not on Fly**. It runs as a user LaunchAgent (`com.jonyen.caption-relay`,
port 8080) alongside a local Apple-transcription sidecar
(`com.jonyen.caption-transcriber`, port 8790, wraps `SpeechAnalyzer`), and is
exposed to the public internet via Tailscale Funnel at
`https://ring.tailb6f6c9.ts.net:10000/`. `TRANSCRIPTION_PROVIDER=apple` points
the relay at the sidecar (and is the code default anyway); there is no
Deepgram key configured on ring — in fact Deepgram support, and the Twilio
phone-call captioning that rode on it, were removed from the backend entirely
(2026-08). See [`deploy/ring/README.md`](../deploy/ring/README.md)
for the full deployment (directory layout, launchd plists, the env file, and
how to redeploy after a code change).

The Fly deployment below is **retired-pending**: the app (`watch-captions-relay`)
still exists and is soaking as a rollback path, but the apps (watch/iOS
`Secrets.swift`) now point at ring, and real transcript/session data has been
migrated off the Fly volume (see "Data migration from Fly" below). Once the
ring deployment has soaked for a few days, the Fly app is scaled to zero and
its Deepgram key revoked — see the retirement checklist in
`deploy/ring/README.md`.

The rest of this document describes the **original Fly.io deployment**,
retained for reference and as a rollback path until the ring deployment has
soaked. Note the rollback path is the *already-deployed* Fly image: current
code has no Deepgram provider anymore, so redeploying it to Fly would caption
nothing without a reachable Apple sidecar (or an OpenAI/AssemblyAI key). The
Deepgram-specific steps below are historical.

---

The service runs via `tsx` (see README). Fly builds the `Dockerfile` and runs it.
Config lives in `fly.toml`. Secrets — e.g. (optionally)
`ADMIN_TOKEN` — are NOT in git; they are set with `fly secrets`. There is no
`AUTH_TOKEN`: devices authenticate by self-registering with `POST /v1/devices`
and getting their own bearer token back — see backend/README.md
"Authentication".

## Data migration from Fly (2026-08-24)

The live Fly deployment (`watch-captions-relay`, machine last updated
2026-08-15) turned out to predate the multi-tenant identity database
entirely — it runs on Node 20 (the identity DB requires Node ≥23.4's
built-in `node:sqlite`, hence the current `Dockerfile`'s `node:24-slim`), has
no `identity.db` at all, and stores transcripts as loose files directly under
`/data/transcripts` rather than per-user subdirectories. There was no
`identity.db` to `fly ssh sftp get` — the brief's assumption that one existed
did not hold.

Instead, the 114 loose transcript files (50 `.jsonl` sessions, 32
`.summary.md`, 32 `.notion.json`, plus a legacy `settings.json`) were pulled
down (`fly ssh console -C "tar czf - -C /data/transcripts ."`, piped straight
to a file — never a value was printed) and copied onto ring's
`TRANSCRIPTS_DIR` root via `rsync`. The relay's own `migrateFlatTranscripts`
(`backend/src/tenantMigration.ts`), which already exists specifically for
this "pre-multi-tenant flat directory" case, ran automatically on the next
boot: it minted one new `mac`-kind user + device for the migrated history,
moved all 114 files under that user's directory, and logged the one-time
bearer token needed to view it at `/app`. Two throwaway `watch` devices
registered during Tasks 5–6's smoke tests remain in ring's identity DB
(harmless test data, `"Hello, this is a test of captions running on the
watch."`) — deleting them was left for the user (see
`.superpowers/sdd/2026-08-24-imac-relay-local-stt/task-7-report.md` for the
exact IDs and cleanup command).

## Prerequisites

1. A Fly.io account and `flyctl` installed (`brew install flyctl`).
2. Credentials for a transcription backend, unless an Apple sidecar is
   reachable from the deploy: `OPENAI_API_KEY` or `ASSEMBLYAI_API_KEY`, with
   `TRANSCRIPTION_PROVIDER` set to match. (This step used to be "a Deepgram
   API key"; that provider is gone.)

## One-time setup

```bash
cd backend

# 1. Log in to Fly (opens a browser).
fly auth login

# 2. Create the app from the existing fly.toml. `fly.dev` names are globally
#    unique and this one is already taken by the upstream deploy, so expect
#    to rename: edit `app = "..."` in fly.toml to something unique, then
#    re-run.
#
#    RENAMING THE APP MEANS RENAMING PUBLIC_BASE_URL TOO. It ships in
#    fly.toml's [env] as "https://watch-captions-relay.fly.dev"; set it to
#    "https://<your-app-name>.fly.dev" in the same edit (or to your custom
#    domain, if you have one). It is what the Notion OAuth redirect URI and
#    the emailed confirmation link are built from, so leaving it pointed at
#    someone else's host sends that host a live Notion authorization code and
#    a live email verification token — along with the user's address. Neither
#    works there, but both leave your relay. The relay warns at boot if this
#    is not "<FLY_APP_NAME>.fly.dev" (`fly logs`); a custom domain warns too
#    and is fine to ignore.
fly apps create watch-captions-relay

# 3. Set the transcription backend and its key (see Prerequisites). There is
#    no relay-wide auth secret to generate — devices self-register at runtime
#    and get their own token.
fly secrets set TRANSCRIPTION_PROVIDER="openai" OPENAI_API_KEY="<your-key>"

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
#        confirmation link both point back at it. Not a secret; it lives in
#        fly.toml's [env], where it ships pointing at the UPSTREAM app's
#        hostname. It is correct only if you kept `app = "watch-captions-relay"`
#        in step 2, which you almost certainly could not. Confirm it reads
#        "https://<your-app-name>.fly.dev" (or your custom domain) before
#        deploying — see step 2 for what leaks if it doesn't.
#
#    7c. A public Notion integration (Type: Public, not the Internal one used
#        by #6) — see backend/README.md "Registering the Notion integration"
#        for the redirect URI it needs and where to find these.
fly secrets set NOTION_CLIENT_ID="<client-id>" NOTION_CLIENT_SECRET="<client-secret>"

#    7d. Resend, for the email export destination — an API key (secret) and
#        the From address (not a secret, but deliberately NOT committed to
#        fly.toml either: unlike PUBLIC_BASE_URL there's no correct default
#        — it must be on a domain verified with Resend — and a shipped
#        placeholder would let this secret alone look like a complete,
#        working setup). Uncomment and set EMAIL_FROM in fly.toml's [env]
#        yourself. See https://resend.com.
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
- `PUBLIC_BASE_URL` lives in `fly.toml`'s `[env]` too, right beside
  `TRUST_PROXY_HEADERS` — it isn't a secret (a deploy's own public address),
  unlike `NOTION_CLIENT_SECRET` and `RESEND_API_KEY`, which are credentials
  and belong only in `fly secrets`. Its committed value names the upstream
  app, so edit it in `fly.toml` whenever your `app = "..."` differs — a
  rename in step 2, or a custom domain. The relay compares it against
  `FLY_APP_NAME` at boot and warns if they disagree, naming both, so a
  mismatch shows up in `fly logs` rather than only in a leaked token.
  `EMAIL_FROM`
  isn't a secret either, but ships **commented out** in `fly.toml` rather
  than with a default value: there's no correct default (it must be on a
  domain verified with Resend), and a placeholder would let setting only the
  `RESEND_API_KEY` secret look like a complete configuration when it isn't.
  Uncomment and set it yourself in `fly.toml` to enable email export.
- `TRUST_PROXY_HEADERS = "true"` in `fly.toml`'s `[env]` is what makes the
  registration rate limit work on Fly: `http_service` terminates the client's
  connection, so without it every caller shares one 10-per-hour bucket and any
  ten registrations would close registration — the only way to get a device
  token — for everyone, for an hour. Only ever set it where a proxy
  **overwrites** `Fly-Client-IP` on the way in (Fly's edge does). If you run
  this relay anywhere the port is reachable directly, unset it: the header is
  caller-supplied there, and trusting it removes the limit entirely. See
  backend/README.md "Rate limiting".
- Cost/usage monitoring (Fly machine status via `GET /v1/usage`) is set up in
  [MONITORING.md](./MONITORING.md).
- To view logs: `fly logs`. To update after code changes: `fly deploy` again.
- Rotate the admin token any time with `fly secrets set ADMIN_TOKEN=<new>`. Per-device
  tokens have no rotation command — re-registering (`POST /v1/devices`) mints a new one
  for that device.
