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

/** HTML report for the email body. */
export function renderHtmlReport(d: ReportData): string {
  const dg = d.deepgram
    ? `
      <tr><td>Audio transcribed</td><td><b>${d.deepgram.hours.toFixed(2)} h</b> (${(d.deepgram.hours * 60).toFixed(1)} min)</td></tr>
      <tr><td>Requests</td><td>${d.deepgram.requests}</td></tr>
      <tr><td>Estimated cost</td><td><b>~${usd(estimateDeepgramCost(d.deepgram.hours, d.deepgramRatePerMin))}</b> <span style="color:#888">(@ $${d.deepgramRatePerMin}/min)</span></td></tr>`
    : `<tr><td colspan="2" style="color:#b00">Unavailable — check DEEPGRAM_API_KEY / DEEPGRAM_PROJECT_ID.</td></tr>`;

  const machineRows = d.fly.machines
    ? d.fly.machines.length === 0
      ? `<tr><td>Machines</td><td>none found</td></tr>`
      : `<tr><td>Machines</td><td>${d.fly.machines
          .map((m) => `${escapeHtml(m.id)} <span style="color:#888">[${escapeHtml(m.state)} · ${escapeHtml(m.region)}]</span>`)
          .join("<br>")}</td></tr>`
    : `<tr><td>Machines</td><td style="color:#888">status unavailable (FLY_API_TOKEN not set)</td></tr>`;

  return `<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a1a1a">
  <h2 style="margin-bottom:0">Watch Captions — Weekly Usage</h2>
  <p style="margin-top:4px;color:#666">Week of ${d.rangeStart} → ${d.rangeEnd} (UTC)</p>

  <h3>Deepgram <span style="color:#888;font-weight:normal">(variable cost)</span></h3>
  <table cellpadding="6" style="border-collapse:collapse;border:1px solid #eee">${dg}</table>

  <h3>Fly.io <span style="color:#888;font-weight:normal">(fixed cost)</span></h3>
  <table cellpadding="6" style="border-collapse:collapse;border:1px solid #eee">
    <tr><td>App</td><td>${escapeHtml(d.fly.appName)}</td></tr>
    ${machineRows}
    <tr><td>Estimated cost</td><td>~${usd(d.fly.monthlyCostUsd)}/month</td></tr>
  </table>

  <p style="color:#888;font-size:12px;margin-top:24px">
    Deepgram cost is an estimate (streamed audio hours × configured rate).
    Confirm exact billing at console.deepgram.com and fly.io/dashboard.
  </p>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}
