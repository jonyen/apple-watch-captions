/**
 * Pure helpers for the on-demand Fly usage report served at GET /v1/usage.
 *
 * All network IO lives in `usageService.ts`; everything here is deterministic
 * and unit-tested so the cost math can't silently drift. (The report used to
 * carry a Deepgram usage/cost section too; it went when the Deepgram provider
 * was retired, 2026-08.)
 */

export interface FlyMachine {
  id: string;
  state: string;
  region: string;
}

export interface ReportData {
  rangeStart: string;
  rangeEnd: string;
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

export function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}
