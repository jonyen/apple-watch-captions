# Cost & Usage Monitoring

A weekly email tracks the two things that cost money:

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
3. Renders a Markdown report and emails it (converted to HTML) via Gmail SMTP.

Every data source is optional — if a key is missing or an API errors, the email
is still sent with the parts it could gather.

## One-time setup (GitHub repo settings)

Add these under **Settings → Secrets and variables → Actions**.

### Secrets

| Secret                   | Required | What it is                                                             |
| ------------------------ | -------- | --------------------------------------------------------------------- |
| `DEEPGRAM_USAGE_API_KEY` | yes      | A Deepgram API key with **Usage: Read** scope. Kept separate from the relay's transcription key (which lives only in Fly secrets). |
| `MAIL_USERNAME`          | yes      | Gmail address the report is sent from (and authenticated as).          |
| `MAIL_PASSWORD`          | yes      | A Gmail [App Password](https://myaccount.google.com/apppasswords) (needs 2FA). Not your normal password. |
| `DEEPGRAM_PROJECT_ID`    | optional | Pins the project. If omitted, the first project on the key is used.    |
| `FLY_API_TOKEN`          | optional | `fly tokens create readonly -o <org>` — enables live machine status.   |

### Variables (optional overrides)

| Variable                | Default                | Purpose                                |
| ----------------------- | ---------------------- | -------------------------------------- |
| `REPORT_EMAIL_TO`       | _(required)_           | Recipient address for the report.      |
| `FLY_APP_NAME`          | `watch-captions-relay` | Fly app to inspect.                    |
| `DEEPGRAM_RATE_PER_MIN` | `0.0077`               | Per-minute rate for the cost estimate. |
| `FLY_MONTHLY_COST`      | `1.94`                 | Fixed monthly Fly estimate shown.      |

## Test it

- **In CI:** Actions tab → *Weekly Usage Report* → **Run workflow** (sends a real email).
- **Locally:**
  ```bash
  cd backend
  DEEPGRAM_API_KEY=<key> FLY_API_TOKEN=<token> npm run usage-report
  ```
  Prints the report to stdout and writes `report.md` (no email is sent locally).

## Adjusting the schedule

Edit the `cron` in `.github/workflows/weekly-usage-report.yml`. Cron is in UTC;
`0 14 * * 1` is Monday 14:00 UTC. Pick a UTC hour that lands in your morning.
