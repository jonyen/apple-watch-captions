# Cost & Usage Monitoring

A weekly email report tracks the two things that cost money:

- **Deepgram** — the variable cost. Billed per minute of audio streamed to the
  `nova-2` live model (~$0.0077/min pay-as-you-go). This is what moves with usage.
- **Fly.io** — the fixed cost. The relay runs one always-on `shared-cpu-1x` /
  256MB machine (~$1.94/month). The report shows machine status so you'll notice
  if extra machines spin up.

## How it works

`.github/workflows/weekly-usage-report.yml` runs every **Monday at 14:00 UTC**
(≈ 7am PDT / 10am EDT) and on manual dispatch. It runs `npm run usage-report`
(`src/usageReportCli.ts`), which:

1. Pulls the last 7 days of Deepgram usage via the
   [Management Usage API](https://developers.deepgram.com/reference/management-api/usage/get)
   and estimates cost = hours × 60 × rate.
2. Pulls Fly machine status via the Machines API.
3. Renders an HTML + plain-text report and emails it to you via SMTP.

Every data source is optional — if a key is missing or an API errors, the report
still sends with the parts it could gather.

## One-time setup (GitHub repo settings)

Add these under **Settings → Secrets and variables → Actions**.

### Secrets

| Secret                | Required | What it is                                                                 |
| --------------------- | -------- | -------------------------------------------------------------------------- |
| `DEEPGRAM_API_KEY`    | yes      | A Deepgram API key with **Usage: read** scope (the relay's key works).     |
| `DEEPGRAM_PROJECT_ID` | optional | Pins the project. If omitted, the first project on the key is used.        |
| `FLY_API_TOKEN`       | optional | `fly tokens create readonly` — enables live machine status.                |
| `MAIL_SERVER`         | yes      | SMTP host, e.g. `smtp.gmail.com`.                                          |
| `MAIL_PORT`           | yes      | SMTP port, e.g. `465` (SSL).                                                |
| `MAIL_USERNAME`       | yes      | SMTP user — the sending Gmail address.                                      |
| `MAIL_PASSWORD`       | yes      | Gmail **App Password** (not your account password). See note below.        |
| `REPORT_TO`           | yes      | Where to send the report, e.g. `jonyen@gmail.com`.                          |

> **Gmail App Password:** with 2FA enabled, create one at
> <https://myaccount.google.com/apppasswords> and use it as `MAIL_PASSWORD`.

### Variables (optional overrides)

| Variable                | Default                 | Purpose                                  |
| ----------------------- | ----------------------- | ---------------------------------------- |
| `FLY_APP_NAME`          | `watch-captions-relay`  | Fly app to inspect.                      |
| `DEEPGRAM_RATE_PER_MIN` | `0.0077`                | Per-minute rate for the cost estimate.  |
| `FLY_MONTHLY_COST`      | `1.94`                  | Fixed monthly Fly estimate shown.       |

## Test it

- **In CI:** Actions tab → *Weekly Usage Report* → **Run workflow**.
- **Locally:**
  ```bash
  cd backend
  DEEPGRAM_API_KEY=<key> FLY_API_TOKEN=<token> npm run usage-report
  ```
  Prints the report to stdout (no email is sent locally).

## Adjusting the schedule

Edit the `cron` in `.github/workflows/weekly-usage-report.yml`. Cron is in UTC;
`0 14 * * 1` is Monday 14:00 UTC. Pick a UTC hour that lands in your morning.
