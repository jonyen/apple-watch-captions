/**
 * Weekly usage-report CLI. Pulls Deepgram usage + Fly machine status, prints a
 * plain-text report to stdout, and (when run under GitHub Actions) writes an
 * HTML body to `report.html` and exports the email subject via $GITHUB_OUTPUT.
 *
 * Run locally:  npm run usage-report
 * Every source is optional: a failure in one is reported in-line, not fatal, so
 * the email still goes out with whatever we could gather.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import {
  lastWeekRange,
  summarizeDeepgram,
  renderTextReport,
  renderMarkdownReport,
  reportSubject,
  type DeepgramUsage,
  type FlyMachine,
  type ReportData,
} from "./usageReport";

const DEEPGRAM_API = "https://api.deepgram.com/v1";
const FLY_API = "https://api.machines.dev/v1";

async function fetchDeepgramUsage(
  apiKey: string,
  projectId: string | undefined,
  start: string,
  end: string,
): Promise<DeepgramUsage> {
  const headers = { Authorization: `Token ${apiKey}`, Accept: "application/json" };

  let pid = projectId;
  if (!pid) {
    const res = await fetch(`${DEEPGRAM_API}/projects`, { headers });
    if (!res.ok) throw new Error(`list projects ${res.status}`);
    const body = (await res.json()) as { projects?: Array<{ project_id: string }> };
    pid = body.projects?.[0]?.project_id;
    if (!pid) throw new Error("no Deepgram projects found");
  }

  const url = `${DEEPGRAM_API}/projects/${pid}/usage?start=${start}&end=${end}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const hint = res.status === 403 ? " (key likely lacks the Usage:Read scope)" : "";
    throw new Error(`usage ${res.status}${hint}`);
  }
  return summarizeDeepgram(await res.json());
}

async function fetchFlyMachines(token: string, app: string): Promise<FlyMachine[]> {
  const res = await fetch(`${FLY_API}/apps/${app}/machines`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`fly machines ${res.status}`);
  const body = (await res.json()) as Array<{ id?: string; state?: string; region?: string }>;
  return (Array.isArray(body) ? body : []).map((m) => ({
    id: m.id ?? "?",
    state: m.state ?? "unknown",
    region: m.region ?? "?",
  }));
}

async function main(): Promise<void> {
  const env = process.env;
  const now = new Date();
  const { start, end } = lastWeekRange(now);

  const appName = env.FLY_APP_NAME || "watch-captions-relay";
  const ratePerMin = Number(env.DEEPGRAM_RATE_PER_MIN) || 0.0077;
  const flyMonthly = Number(env.FLY_MONTHLY_COST) || 1.94;

  let deepgram: DeepgramUsage | null = null;
  let deepgramError: string | undefined;
  if (env.DEEPGRAM_API_KEY) {
    try {
      deepgram = await fetchDeepgramUsage(env.DEEPGRAM_API_KEY, env.DEEPGRAM_PROJECT_ID, start, end);
    } catch (err) {
      deepgramError = `Deepgram API error: ${(err as Error).message}`;
      console.error(`Deepgram usage fetch failed: ${(err as Error).message}`);
    }
  } else {
    deepgramError = "DEEPGRAM_API_KEY not set";
    console.error("DEEPGRAM_API_KEY not set — skipping Deepgram usage.");
  }

  let machines: FlyMachine[] | null = null;
  let machinesError: string | undefined;
  if (env.FLY_API_TOKEN) {
    try {
      machines = await fetchFlyMachines(env.FLY_API_TOKEN, appName);
    } catch (err) {
      machinesError = `Fly API error: ${(err as Error).message}`;
      console.error(`Fly machines fetch failed: ${(err as Error).message}`);
    }
  } else {
    machinesError = "FLY_API_TOKEN not set";
    console.error("FLY_API_TOKEN not set — reporting fixed Fly estimate only.");
  }

  const data: ReportData = {
    rangeStart: start,
    rangeEnd: end,
    deepgram,
    deepgramError,
    deepgramRatePerMin: ratePerMin,
    fly: { appName, machines, machinesError, monthlyCostUsd: flyMonthly },
  };

  console.log(renderTextReport(data));

  // Hand the report off to the GitHub Actions "create issue" step.
  writeFileSync("report.md", renderMarkdownReport(data));
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `title=${reportSubject(data)}\n`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
