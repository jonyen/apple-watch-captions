/**
 * Pure helpers for the weekly Deepgram + Fly usage report.
 *
 * All network / filesystem IO lives in `usageReportCli.ts`; everything here is
 * deterministic and unit-tested so the cost math and formatting can't silently
 * drift.
 */

export interface DeepgramUsage {
  hours: number;
  requests: number;
}

export interface FlyMachine {
  id: string;
  state: string;
  region: string;
}

export interface ReportData {
  rangeStart: string;
  rangeEnd: string;
  /** null when usage could not be fetched (missing key / API error). */
  deepgram: DeepgramUsage | null;
  deepgramRatePerMin: number;
  fly: {
    appName: string;
    /** null when the Fly token is absent or the API call failed. */
    machines: FlyMachine[] | null;
    monthlyCostUsd: number;
  };
}

/** 7-day window ending at `now`, as UTC `YYYY-MM-DD` strings. */
export function lastWeekRange(now: Date): { start: string; end: string } {
  const end = toUtcDate(now);
  const start = toUtcDate(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000));
  return { start, end };
}

function toUtcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Sum hours + requests from a Deepgram `/usage` summary response (defensive). */
export function summarizeDeepgram(json: unknown): DeepgramUsage {
  const results = (json as { results?: unknown })?.results;
  const rows: Array<Record<string, unknown>> = Array.isArray(results) ? results : [];
  let hours = 0;
  let requests = 0;
  for (const r of rows) {
    hours += num(r.total_hours ?? r.hours);
    requests += num(r.requests);
  }
  return { hours, requests };
}

/** Estimated Deepgram spend for `hours` of streamed audio at `ratePerMinUsd`. */
export function estimateDeepgramCost(hours: number, ratePerMinUsd: number): number {
  return hours * 60 * ratePerMinUsd;
}

export function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function reportSubject(d: ReportData): string {
  if (!d.deepgram) {
    return `Watch Captions weekly usage — Deepgram data unavailable (week of ${d.rangeStart})`;
  }
  const cost = estimateDeepgramCost(d.deepgram.hours, d.deepgramRatePerMin);
  return `Watch Captions weekly usage — ${d.deepgram.hours.toFixed(2)}h, ~${usd(cost)} (week of ${d.rangeStart})`;
}

/** Plain-text report (used in the Actions log and as an email fallback). */
export function renderTextReport(d: ReportData): string {
  const lines: string[] = [];
  lines.push("Watch Captions — Weekly Usage Report");
  lines.push(`Week: ${d.rangeStart} → ${d.rangeEnd} (UTC)`);
  lines.push("");

  lines.push("Deepgram (variable cost)");
  if (d.deepgram) {
    const minutes = d.deepgram.hours * 60;
    const cost = estimateDeepgramCost(d.deepgram.hours, d.deepgramRatePerMin);
    lines.push(`  Audio transcribed : ${d.deepgram.hours.toFixed(2)} h (${minutes.toFixed(1)} min)`);
    lines.push(`  Requests          : ${d.deepgram.requests}`);
    lines.push(`  Est. cost         : ~${usd(cost)}  (@ $${d.deepgramRatePerMin}/min)`);
  } else {
    lines.push("  Unavailable — check DEEPGRAM_API_KEY / DEEPGRAM_PROJECT_ID.");
  }
  lines.push("");

  lines.push("Fly.io (fixed cost)");
  lines.push(`  App       : ${d.fly.appName}`);
  if (d.fly.machines) {
    if (d.fly.machines.length === 0) {
      lines.push("  Machines  : none found");
    } else {
      for (const m of d.fly.machines) {
        lines.push(`  Machine   : ${m.id} [${m.state}] in ${m.region}`);
      }
    }
  } else {
    lines.push("  Machines  : status unavailable (FLY_API_TOKEN not set)");
  }
  lines.push(`  Est. cost : ~${usd(d.fly.monthlyCostUsd)}/month (always-on machine)`);
  lines.push("");

  lines.push("Notes");
  lines.push("  - Deepgram cost is an estimate: streamed audio hours × configured rate.");
  lines.push("  - Confirm exact billing at console.deepgram.com and fly.io/dashboard.");
  return lines.join("\n");
}

/** Markdown report for a GitHub issue body. */
export function renderMarkdownReport(d: ReportData): string {
  const lines: string[] = [];
  lines.push(`**Week of ${d.rangeStart} → ${d.rangeEnd} (UTC)**`);
  lines.push("");

  lines.push("### Deepgram — variable cost");
  if (d.deepgram) {
    const minutes = d.deepgram.hours * 60;
    const cost = estimateDeepgramCost(d.deepgram.hours, d.deepgramRatePerMin);
    lines.push("| Metric | Value |");
    lines.push("| --- | --- |");
    lines.push(`| Audio transcribed | **${d.deepgram.hours.toFixed(2)} h** (${minutes.toFixed(1)} min) |`);
    lines.push(`| Requests | ${d.deepgram.requests} |`);
    lines.push(`| Est. cost | **~${usd(cost)}** (@ $${d.deepgramRatePerMin}/min) |`);
  } else {
    lines.push("_Unavailable — check `DEEPGRAM_API_KEY` / `DEEPGRAM_PROJECT_ID`._");
  }
  lines.push("");

  lines.push("### Fly.io — fixed cost");
  lines.push("| Metric | Value |");
  lines.push("| --- | --- |");
  lines.push(`| App | \`${d.fly.appName}\` |`);
  if (d.fly.machines) {
    const desc =
      d.fly.machines.length === 0
        ? "none found"
        : d.fly.machines.map((m) => `\`${m.id}\` [${m.state} · ${m.region}]`).join("<br>");
    lines.push(`| Machines | ${desc} |`);
  } else {
    lines.push("| Machines | status unavailable (`FLY_API_TOKEN` not set) |");
  }
  lines.push(`| Est. cost | ~${usd(d.fly.monthlyCostUsd)}/month (always-on machine) |`);
  lines.push("");

  lines.push(
    "> Deepgram cost is an estimate (streamed audio hours × configured rate). " +
      "Confirm exact billing at [console.deepgram.com](https://console.deepgram.com) " +
      "and [fly.io/dashboard](https://fly.io/dashboard).",
  );
  return lines.join("\n");
}

