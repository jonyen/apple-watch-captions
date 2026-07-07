/**
 * Pure helpers for the on-demand Deepgram + Fly usage report served at
 * GET /v1/usage.
 *
 * All network IO lives in `usageService.ts`; everything here is deterministic
 * and unit-tested so the cost math can't silently drift.
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
