/**
 * On-demand usage data for GET /v1/usage: Fly machine status and the fixed
 * monthly estimate, with a short in-memory cache so menu clicks don't hammer
 * the upstream API. Fetch logic moved here from the retired weekly-email CLI.
 * (A Deepgram usage/cost section lived here too until the Deepgram provider
 * was retired, 2026-08.)
 */
import { lastWeekRange, type FlyMachine, type ReportData } from "./usageReport";

const FLY_API = "https://api.machines.dev/v1";

export interface UsageServiceOptions {
  env: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  cacheTtlMs?: number;
}

export interface UsageService {
  getUsage(): Promise<ReportData>;
}

export function createUsageService(opts: UsageServiceOptions): UsageService {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date());
  const ttl = opts.cacheTtlMs ?? 5 * 60 * 1000;
  const env = opts.env;

  let cached: { at: number; data: ReportData } | null = null;

  async function fetchMachines(app: string): Promise<FlyMachine[]> {
    const res = await fetchImpl(`${FLY_API}/apps/${app}/machines`, {
      headers: { Authorization: `Bearer ${env.FLY_API_TOKEN}`, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`fly machines ${res.status}`);
    const body = (await res.json()) as Array<{ id?: string; state?: string; region?: string }>;
    return (Array.isArray(body) ? body : []).map((m) => ({
      id: m.id ?? "?",
      state: m.state ?? "unknown",
      region: m.region ?? "?",
    }));
  }

  async function build(): Promise<ReportData> {
    const { start, end } = lastWeekRange(now());
    const appName = env.FLY_APP_NAME || "watch-captions-relay";
    const flyMonthly = Number(env.FLY_MONTHLY_COST) || 1.94;

    let machines: FlyMachine[] | null = null;
    let machinesError: string | undefined;
    if (env.FLY_API_TOKEN) {
      try {
        machines = await fetchMachines(appName);
      } catch (err) {
        machinesError = `Fly API error: ${(err as Error).message}`;
      }
    } else {
      machinesError = "FLY_API_TOKEN not set";
    }

    return {
      rangeStart: start,
      rangeEnd: end,
      fly: { appName, machines, machinesError, monthlyCostUsd: flyMonthly },
    };
  }

  return {
    async getUsage(): Promise<ReportData> {
      const t = now().getTime();
      if (cached && t - cached.at < ttl) return cached.data;
      const data = await build();
      cached = { at: t, data };
      return data;
    },
  };
}
