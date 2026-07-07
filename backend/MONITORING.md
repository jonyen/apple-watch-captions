# Cost & Usage Monitoring

Usage is on-demand: the mac app's **Usage…** menu item (or any client) calls
`GET /v1/usage?token=<AUTH_TOKEN>` on the relay, which reports:

- **Deepgram** — last 7 days of streamed audio (hours, requests) and an
  estimated cost (hours × 60 × rate, default $0.0077/min for `nova-2`).
- **Fly.io** — machine list/status for the relay app and the fixed monthly
  estimate (~$1.94 for one always-on `shared-cpu-1x`).

Results are cached in-process for 5 minutes.

## Setup (Fly secrets — all optional)

| Secret / env             | What it is                                                           |
| ------------------------ | -------------------------------------------------------------------- |
| `DEEPGRAM_USAGE_API_KEY` | Deepgram key with **Usage: Read** scope (separate from the transcription key). Without it the Deepgram section reads "not set". |
| `DEEPGRAM_PROJECT_ID`    | Optional; pins the project. Defaults to the key's first project.      |
| `FLY_API_TOKEN`          | `fly tokens create readonly -o <org>` — enables live machine status.  |
| `FLY_APP_NAME`           | Default `watch-captions-relay`.                                       |
| `DEEPGRAM_RATE_PER_MIN`  | Default `0.0077`.                                                     |
| `FLY_MONTHLY_COST`       | Default `1.94`.                                                       |

```bash
cd backend
fly secrets set DEEPGRAM_USAGE_API_KEY=<key> FLY_API_TOKEN=<token>
```

Missing keys or upstream errors never fail the endpoint — the affected
section comes back `null` with a reason string
(`deepgramError` / `machinesError`).

## Test it

```bash
curl "https://watch-captions-relay.fly.dev/v1/usage?token=$AUTH_TOKEN" | jq
```

## History

The weekly email report (GitHub Actions + Gmail SMTP) was removed 2026-07-06
in favor of this endpoint. If the old GitHub repo secrets are still set,
delete them: `MAIL_USERNAME`, `MAIL_PASSWORD`, `DEEPGRAM_USAGE_API_KEY`,
`DEEPGRAM_PROJECT_ID`, `FLY_API_TOKEN`, and the `REPORT_EMAIL_TO` variable.
