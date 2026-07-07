/**
 * On-demand usage data for GET /v1/usage: Deepgram last-7-days usage and Fly
 * machine status, with a short in-memory cache so menu clicks don't hammer
 * the upstream APIs. Fetch logic moved here from the retired weekly-email CLI.
 */
import {
  lastWeekRange,
  summarizeDeepgram,
  type DeepgramUsage,
  type FlyMachine,
  type ReportData,
} from "./usageReport";

const DEEPGRAM_API = "https://api.deepgram.com/v1";
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

  async function fetchDeepgram(start: string, end: string): Promise<DeepgramUsage> {
    const key = env.DEEPGRAM_USAGE_API_KEY!;
    const headers = { Authorization: `Token ${key}`, Accept: "application/json" };
    let pid = env.DEEPGRAM_PROJECT_ID;
    if (!pid) {
      const res = await fetchImpl(`${DEEPGRAM_API}/projects`, { headers });
      if (!res.ok) throw new Error(`list projects ${res.status}`);
      const body = (await res.json()) as { projects?: Array<{ project_id: string }> };
      pid = body.projects?.[0]?.project_id;
      if (!pid) throw new Error("no Deepgram projects found");
    }
    const res = await fetchImpl(`${DEEPGRAM_API}/projects/${pid}/usage?start=${start}&end=${end}`, {
      headers,
    });
    if (!res.ok) {
      const hint = res.status === 403 ? " (key likely lacks the Usage:Read scope)" : "";
      throw new Error(`usage ${res.status}${hint}`);
    }
    return summarizeDeepgram(await res.json());
  }

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
    const ratePerMin = Number(env.DEEPGRAM_RATE_PER_MIN) || 0.0077;
    const flyMonthly = Number(env.FLY_MONTHLY_COST) || 1.94;

    let deepgram: DeepgramUsage | null = null;
    let deepgramError: string | undefined;
    if (env.DEEPGRAM_USAGE_API_KEY) {
      try {
        deepgram = await fetchDeepgram(start, end);
      } catch (err) {
        deepgramError = `Deepgram API error: ${(err as Error).message}`;
      }
    } else {
      deepgramError = "DEEPGRAM_USAGE_API_KEY not set";
    }

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
      deepgram,
      deepgramError,
      deepgramRatePerMin: ratePerMin,
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
