# Cost & Usage Monitoring

A weekly GitHub issue tracks the two things that cost money:

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
3. Renders a Markdown report and opens a GitHub issue (labeled `usage-report`).

Every data source is optional — if a key is missing or an API errors, the issue
is still created with the parts it could gather.

> Subscribe to the repo (or the `usage-report` label) to get the issue in your
> inbox each Monday.

## One-time setup (GitHub repo settings)

Add these under **Settings → Secrets and variables → Actions**. The issue is
created with the built-in `GITHUB_TOKEN`, so no extra auth is needed for posting.

### Secrets

| Secret                | Required | What it is                                                             |
| --------------------- | -------- | --------------------------------------------------------------------- |
| `DEEPGRAM_API_KEY`    | yes      | A Deepgram API key with **Usage: read** scope (the relay's key works). |
| `DEEPGRAM_PROJECT_ID` | optional | Pins the project. If omitted, the first project on the key is used.    |
| `FLY_API_TOKEN`       | optional | `fly tokens create readonly` — enables live machine status.            |

### Variables (optional overrides)

| Variable                | Default                | Purpose                                |
| ----------------------- | ---------------------- | -------------------------------------- |
| `FLY_APP_NAME`          | `watch-captions-relay` | Fly app to inspect.                    |
| `DEEPGRAM_RATE_PER_MIN` | `0.0077`               | Per-minute rate for the cost estimate. |
| `FLY_MONTHLY_COST`      | `1.94`                 | Fixed monthly Fly estimate shown.      |

## Test it

- **In CI:** Actions tab → *Weekly Usage Report* → **Run workflow**.
- **Locally:**
  ```bash
  cd backend
  DEEPGRAM_API_KEY=<key> FLY_API_TOKEN=<token> npm run usage-report
  ```
  Prints the report to stdout and writes `report.md` (no issue is created locally).

## Adjusting the schedule

Edit the `cron` in `.github/workflows/weekly-usage-report.yml`. Cron is in UTC;
`0 14 * * 1` is Monday 14:00 UTC. Pick a UTC hour that lands in your morning.
