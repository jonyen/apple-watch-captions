# Usage in the Mac Menu — Design

**Date:** 2026-07-06
**Status:** Approved

## Goal

Replace the weekly usage email (GitHub Actions + Gmail SMTP) with an on-demand
**Usage…** item in the mac app's menu-bar dropdown that opens a window showing
the same data: Deepgram usage/cost for the last 7 days and Fly machine status.

## Why

- The email was built when there was no client UI; the mac app now exists and
  is where the user already looks.
- Kills the Gmail App Password + GitHub secrets maintenance surface.

## Architecture

```
 Mac app                       Fly relay                    Deepgram / Fly APIs
┌──────────────┐  GET /v1/usage ┌──────────────┐  server-side ┌────────────────┐
│ Usage window │ ─────────────► │ usage handler │ ───────────► │ Mgmt Usage API │
│ (SwiftUI)    │ ◄───────────── │ + 5min cache  │ ◄─────────── │ Machines API   │
└──────────────┘   ReportData   └──────────────┘              └────────────────┘
```

API keys stay on the relay (Fly secrets); the mac app authenticates with the
existing relay token only.

## Components

### 1. Backend — `GET /v1/usage`

- Token-authenticated like every other endpoint (`?token=`).
- Response: the existing `ReportData` shape from `usageReport.ts`, serialized
  as JSON. Reuses `lastWeekRange`, `summarizeDeepgram`, `estimateDeepgramCost`
  (already unit-tested) — the fetch orchestration moves from `usageReportCli.ts`
  into a new server-side module.
- New (optional) Fly secrets / env:
  - `DEEPGRAM_USAGE_API_KEY` — Deepgram key with Usage:Read scope. Kept
    separate from the transcription key.
  - `DEEPGRAM_PROJECT_ID` — optional, pins the project.
  - `FLY_API_TOKEN` — read-only Machines API token.
  - Existing `FLY_APP_NAME`, `DEEPGRAM_RATE_PER_MIN`, `FLY_MONTHLY_COST`
    overrides keep their defaults.
- Graceful degradation (same contract the email had): a missing key or a
  failed upstream call nulls that section and sets `deepgramError` /
  `machinesError`; the endpoint itself still returns 200.
- **Cache:** in-memory, 5-minute TTL, per-process. Repeated menu clicks don't
  hammer the Deepgram Management API. No persistence needed.

### 2. Mac app — Usage window

- New menu item **Usage…** above **Transcripts…**, opening
  `Window("Usage", id: "usage")`, with the `NSApp.activate(ignoringOtherApps:)`
  call before `openWindow` (same LSUIElement fix as Settings/Transcripts).
- `UsageView`:
  - Fetches `GET /v1/usage` via `RelayAPI` on appear, with a Refresh button.
  - Section **Deepgram — variable cost**: hours (and minutes), request count,
    estimated cost at the configured rate.
  - Section **Fly.io — fixed cost**: app name, machine list (id/state/region),
    monthly estimate.
  - Unavailable states render the `deepgramError` / `machinesError` strings
    inline, mirroring the old email's behavior.
  - Unconfigured app (no relay URL/token) shows the standard "Set the relay
    URL and token in Settings." message.

### 3. Email removal

- Delete `.github/workflows/weekly-usage-report.yml`.
- Delete `backend/src/usageReportCli.ts`.
- In `usageReport.ts`: keep `ReportData`, range/summarize/cost helpers; delete
  `reportSubject`, `renderTextReport`, `renderHtmlReport`,
  `renderMarkdownReport` and their tests.
- Rewrite `MONITORING.md` for the new flow (endpoint + Fly secrets setup).
- Retire GitHub repo secrets `MAIL_USERNAME`, `MAIL_PASSWORD`,
  `DEEPGRAM_USAGE_API_KEY`, `DEEPGRAM_PROJECT_ID`, `FLY_API_TOKEN` and the
  `REPORT_EMAIL_TO` variable (manual step, listed in MONITORING.md).

## Error handling

- Relay unreachable / bad token → UsageView shows the transport error text.
- Upstream API failure → 200 with the failing section nulled + reason string
  (never blocks the other section).
- No client retry loop; user presses Refresh.

## Testing

- Backend: unit tests for the usage handler — auth required, cache TTL
  honored, upstream failure produces nulled section with reason, happy path
  shape. Upstream APIs faked; no network in tests.
- `usageReport.test.ts`: drop renderer tests, keep math/summarize tests.
- Mac: `UsageView` model logic testable via `RelayAPI` protocol seam if one
  exists; otherwise view stays thin over the decoded `ReportData`.

## Out of scope

- Historical usage graphs / date-range pickers.
- Watch app usage display.
- Real billing API integration (numbers stay estimates).
