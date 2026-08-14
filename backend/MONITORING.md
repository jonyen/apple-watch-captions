# Cost & Usage Monitoring

Usage is on-demand: the mac app's **Usage…** menu item (or any client) calls
`GET /v1/usage` on the relay with `Authorization: Bearer <ADMIN_TOKEN>`,
which reports:

- **Deepgram** — last 7 days of streamed audio (hours, requests) and an
  estimated cost (hours × 60 × rate, default $0.0077/min for `nova-2`).
- **Fly.io** — machine list/status for the relay app and the fixed monthly
  estimate (~$1.94 for one always-on `shared-cpu-1x`).

Results are cached in-process for 5 minutes.

## Setup (Fly secrets)

| Secret / env             | What it is                                                           |
| ------------------------ | -------------------------------------------------------------------- |
| `ADMIN_TOKEN`             | **Required for the endpoint to be reachable at all.** Gates `GET /v1/usage` — this reports the operator's whole Deepgram/Fly bill, not a per-user figure, so it is checked against this relay-wide secret rather than any device's own token. With no `ADMIN_TOKEN` set, `/v1/usage` answers `401` unconditionally. Sent as an `Authorization: Bearer` header; this route does not accept `?token=`. |
| `DEEPGRAM_USAGE_API_KEY` | Optional; Deepgram key with **Usage: Read** scope (separate from the transcription key). Without it the Deepgram section reads "not set". |
| `DEEPGRAM_PROJECT_ID`    | Optional; pins the project. Defaults to the key's first project.      |
| `FLY_API_TOKEN`          | Optional; `fly tokens create readonly -o <org>` — enables live machine status.  |
| `FLY_APP_NAME`           | Optional; default `watch-captions-relay`.                             |
| `DEEPGRAM_RATE_PER_MIN`  | Optional; default `0.0077`.                                           |
| `FLY_MONTHLY_COST`       | Optional; default `1.94`.                                             |

```bash
cd backend
fly secrets set ADMIN_TOKEN=$(openssl rand -hex 32) DEEPGRAM_USAGE_API_KEY=<key> FLY_API_TOKEN=<token>
```

Missing keys or upstream errors never fail the endpoint — the affected
section comes back `null` with a reason string
(`deepgramError` / `machinesError`).

## Test it

```bash
# Header, not ?token= — the admin token is the one shared secret in the
# system, and a query string ends up in access logs and shell history. This
# route accepts the header only.
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://watch-captions-relay.fly.dev/v1/usage | jq
```

## History

The weekly email report (GitHub Actions + Gmail SMTP) was removed 2026-07-06
in favor of this endpoint. If the old GitHub repo secrets are still set,
delete them: `MAIL_USERNAME`, `MAIL_PASSWORD`, `DEEPGRAM_USAGE_API_KEY`,
`DEEPGRAM_PROJECT_ID`, `FLY_API_TOKEN`, and the `REPORT_EMAIL_TO` variable.
