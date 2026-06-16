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
  /** Why `deepgram` is null — distinguishes "not configured" from an API error. */
  deepgramError?: string;
  deepgramRatePerMin: number;
  fly: {
    appName: string;
    /** null when the Fly token is absent or the API call failed. */
    machines: FlyMachine[] | null;
    /** Why `machines` is null — distinguishes "not configured" from an API error. */
    machinesError?: string;
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
    lines.push(`  Unavailable — ${d.deepgramError ?? "check DEEPGRAM_API_KEY / DEEPGRAM_PROJECT_ID."}`);
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
    lines.push(`  Machines  : status unavailable — ${d.fly.machinesError ?? "FLY_API_TOKEN not set"}`);
  }
  lines.push(`  Est. cost : ~${usd(d.fly.monthlyCostUsd)}/month (always-on machine)`);
  lines.push("");

  lines.push("Notes");
  lines.push("  - Deepgram cost is an estimate: streamed audio hours × configured rate.");
  lines.push("  - Confirm exact billing at console.deepgram.com and fly.io/dashboard.");
  return lines.join("\n");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * HTML report for the weekly email. Uses real `<table>` markup with inline
 * styles (the only CSS most mail clients honor) so the layout survives Gmail,
 * Apple Mail, etc. — unlike Markdown pipe-tables, which many clients render as
 * raw `| ... |` text.
 */
export function renderHtmlReport(d: ReportData): string {
  const tableStyle = "border-collapse:collapse;margin:6px 0;font-size:14px";
  const td = "border:1px solid #ddd;padding:6px 10px;text-align:left";
  const th = `${td};background:#f5f5f5`;
  const row = (label: string, value: string) =>
    `<tr><td style="${td}">${label}</td><td style="${td}">${value}</td></tr>`;
  const header = `<tr><th style="${th}">Metric</th><th style="${th}">Value</th></tr>`;

  let deepgramRows: string;
  if (d.deepgram) {
    const minutes = d.deepgram.hours * 60;
    const cost = estimateDeepgramCost(d.deepgram.hours, d.deepgramRatePerMin);
    deepgramRows =
      row("Audio transcribed", `<strong>${d.deepgram.hours.toFixed(2)} h</strong> (${minutes.toFixed(1)} min)`) +
      row("Requests", String(d.deepgram.requests)) +
      row("Est. cost", `<strong>~${usd(cost)}</strong> (@ $${d.deepgramRatePerMin}/min)`);
  } else {
    const reason = escapeHtml(d.deepgramError ?? "check DEEPGRAM_API_KEY / DEEPGRAM_PROJECT_ID.");
    deepgramRows = `<tr><td style="${td}" colspan="2"><em>Unavailable — ${reason}</em></td></tr>`;
  }

  let flyMachines: string;
  if (d.fly.machines) {
    flyMachines =
      d.fly.machines.length === 0
        ? "none found"
        : d.fly.machines
            .map((m) => `<code>${escapeHtml(m.id)}</code> [${escapeHtml(m.state)} · ${escapeHtml(m.region)}]`)
            .join("<br>");
  } else {
    flyMachines = `status unavailable — ${escapeHtml(d.fly.machinesError ?? "FLY_API_TOKEN not set")}`;
  }
  const flyRows =
    row("App", `<code>${escapeHtml(d.fly.appName)}</code>`) +
    row("Machines", flyMachines) +
    row("Est. cost", `~${usd(d.fly.monthlyCostUsd)}/month (always-on machine)`);

  return [
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#222">`,
    `<p style="margin:0 0 12px"><strong>Week of ${d.rangeStart} → ${d.rangeEnd} (UTC)</strong></p>`,
    `<h3 style="margin:16px 0 4px">Deepgram — variable cost</h3>`,
    `<table style="${tableStyle}">${header}${deepgramRows}</table>`,
    `<h3 style="margin:16px 0 4px">Fly.io — fixed cost</h3>`,
    `<table style="${tableStyle}">${header}${flyRows}</table>`,
    `<p style="color:#666;font-size:12px;margin-top:16px">Deepgram cost is an estimate (streamed audio hours × configured rate). ` +
      `Confirm exact billing at <a href="https://console.deepgram.com">console.deepgram.com</a> ` +
      `and <a href="https://fly.io/dashboard">fly.io/dashboard</a>.</p>`,
    `</div>`,
  ].join("\n");
}

/** Markdown report (kept for local/plain-text use). */
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
    lines.push(`_Unavailable — ${d.deepgramError ?? "check `DEEPGRAM_API_KEY` / `DEEPGRAM_PROJECT_ID`."}_`);
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
    lines.push(`| Machines | status unavailable — ${d.fly.machinesError ?? "`FLY_API_TOKEN` not set"} |`);
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

