# Cost & Usage Monitoring

Usage is on-demand: the mac app's **Usage…** menu item (or any client) calls
`GET /v1/usage` on the relay with `Authorization: Bearer <ADMIN_TOKEN>`,
which reports:

- **Fly.io** — machine list/status for the relay app and the fixed monthly
  estimate (~$1.94 for one always-on `shared-cpu-1x`).

Results are cached in-process for 5 minutes.

## Setup (Fly secrets)

| Secret / env             | What it is                                                           |
| ------------------------ | -------------------------------------------------------------------- |
| `ADMIN_TOKEN`             | **Required for the endpoint to be reachable at all.** Gates `GET /v1/usage` — this reports the operator's whole hosting bill, not a per-user figure, so it is checked against this relay-wide secret rather than any device's own token. With no `ADMIN_TOKEN` set, `/v1/usage` answers `401` unconditionally. Sent as an `Authorization: Bearer` header; this route does not accept `?token=`. |
| `FLY_API_TOKEN`          | Optional; `fly tokens create readonly -o <org>` — enables live machine status.  |
| `FLY_APP_NAME`           | Optional; default `watch-captions-relay`.                             |
| `FLY_MONTHLY_COST`       | Optional; default `1.94`.                                             |

```bash
cd backend
fly secrets set ADMIN_TOKEN=$(openssl rand -hex 32) FLY_API_TOKEN=<token>
```

A missing token or an upstream error never fails the endpoint — the machines
section comes back `null` with a reason string (`machinesError`).

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

The report's Deepgram section (last-7-days streamed hours/requests and an
estimated cost, read with `DEEPGRAM_USAGE_API_KEY` / `DEEPGRAM_PROJECT_ID` /
`DEEPGRAM_RATE_PER_MIN`) was removed 2026-08 when the Deepgram provider was
retired — those env vars and the `deepgram*` fields in the `/v1/usage`
response no longer exist. Unset the vars anywhere they linger.
