# Usage Menu Item Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the weekly usage email with a relay `GET /v1/usage` endpoint and a **Usage…** menu item in the mac app that opens a window showing Deepgram + Fly cost data.

**Architecture:** A new `usageService.ts` module owns the Deepgram/Fly fetches (moved from `usageReportCli.ts`) plus a 5-minute in-memory cache; `server.ts` exposes it at token-authed `GET /v1/usage` returning the existing `ReportData` JSON shape. The mac app decodes that into a new `UsageView` window. Email workflow, CLI, and HTML/text renderers are deleted.

**Tech Stack:** Node/TypeScript + Vitest (backend), SwiftUI (mac app), XcodeGen.

**Spec:** `docs/superpowers/specs/2026-07-06-usage-menu-item-design.md`

## Global Constraints

- All relay endpoints authenticate with `?token=` checked via `verifyToken` (`backend/src/auth.ts`).
- `/v1/usage` returns 200 even when upstream sources fail; failing section is `null` with `deepgramError`/`machinesError` reason string (spec "Graceful degradation").
- No network in backend tests — upstream calls faked via injected `fetchImpl`.
- Env names exactly: `DEEPGRAM_USAGE_API_KEY`, `DEEPGRAM_PROJECT_ID`, `FLY_API_TOKEN`, `FLY_APP_NAME` (default `watch-captions-relay`), `DEEPGRAM_RATE_PER_MIN` (default `0.0077`), `FLY_MONTHLY_COST` (default `1.94`).
- Mac app: any window opened from the menu must call `NSApp.activate(ignoringOtherApps: true)` first (LSUIElement fix).
- Run backend tests with `cd backend && npx vitest run <file>`; full suite `npm test`.

---

### Task 1: Backend usage service (fetch + cache)

**Files:**
- Create: `backend/src/usageService.ts`
- Test: `backend/src/usageService.test.ts`

**Interfaces:**
- Consumes: `lastWeekRange`, `summarizeDeepgram`, `ReportData`, `DeepgramUsage`, `FlyMachine` from `./usageReport`.
- Produces: `createUsageService(opts: UsageServiceOptions): UsageService` where `UsageService = { getUsage(): Promise<ReportData> }`. Task 2 passes a `UsageService` to the server; Task 3 constructs it from env.

- [ ] **Step 1: Write failing tests**

`backend/src/usageService.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { createUsageService } from "./usageService";

const DG_PROJECTS = { projects: [{ project_id: "p1" }] };
const DG_USAGE = { results: [{ total_hours: 2, requests: 10 }] };
const FLY_MACHINES = [{ id: "m1", state: "started", region: "ord" }];

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

/** fetchImpl serving Deepgram projects/usage and Fly machines endpoints. */
function fakeFetch(overrides: Record<string, () => Response> = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [substr, make] of Object.entries(overrides)) {
      if (url.includes(substr)) return make();
    }
    if (url.includes("/projects") && !url.includes("/usage")) return okJson(DG_PROJECTS);
    if (url.includes("/usage")) return okJson(DG_USAGE);
    if (url.includes("/machines")) return okJson(FLY_MACHINES);
    return new Response("not found", { status: 404 });
  });
}

function service(env: Record<string, string>, fetchImpl = fakeFetch(), nowMs = { t: 1_000_000 }) {
  return {
    svc: createUsageService({
      env,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => new Date(nowMs.t),
      cacheTtlMs: 300_000,
    }),
    fetchImpl,
    nowMs,
  };
}

const FULL_ENV = { DEEPGRAM_USAGE_API_KEY: "dk", FLY_API_TOKEN: "ft" };

describe("createUsageService", () => {
  it("returns both sections on the happy path", async () => {
    const { svc } = service(FULL_ENV);
    const d = await svc.getUsage();
    expect(d.deepgram).toEqual({ hours: 2, requests: 10 });
    expect(d.fly.machines).toEqual([{ id: "m1", state: "started", region: "ord" }]);
    expect(d.fly.appName).toBe("watch-captions-relay");
    expect(d.deepgramRatePerMin).toBe(0.0077);
    expect(d.fly.monthlyCostUsd).toBe(1.94);
  });

  it("skips the projects lookup when DEEPGRAM_PROJECT_ID is set", async () => {
    const { svc, fetchImpl } = service({ ...FULL_ENV, DEEPGRAM_PROJECT_ID: "px" });
    await svc.getUsage();
    const urls = fetchImpl.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/projects/px/usage"))).toBe(true);
    expect(urls.some((u) => u.endsWith("/projects"))).toBe(false);
  });

  it("nulls deepgram with reason when the key is missing", async () => {
    const { svc } = service({ FLY_API_TOKEN: "ft" });
    const d = await svc.getUsage();
    expect(d.deepgram).toBeNull();
    expect(d.deepgramError).toBe("DEEPGRAM_USAGE_API_KEY not set");
    expect(d.fly.machines).not.toBeNull();
  });

  it("nulls machines with reason when the token is missing", async () => {
    const { svc } = service({ DEEPGRAM_USAGE_API_KEY: "dk" });
    const d = await svc.getUsage();
    expect(d.fly.machines).toBeNull();
    expect(d.fly.machinesError).toBe("FLY_API_TOKEN not set");
    expect(d.deepgram).not.toBeNull();
  });

  it("reports an upstream failure without failing the other section", async () => {
    const fetchImpl = fakeFetch({ "/usage": () => new Response("no", { status: 403 }) });
    const { svc } = service(FULL_ENV, fetchImpl);
    const d = await svc.getUsage();
    expect(d.deepgram).toBeNull();
    expect(d.deepgramError).toContain("403");
    expect(d.fly.machines).toEqual([{ id: "m1", state: "started", region: "ord" }]);
  });

  it("honors env overrides for app name, rate, and monthly cost", async () => {
    const { svc } = service({
      ...FULL_ENV,
      FLY_APP_NAME: "other-app",
      DEEPGRAM_RATE_PER_MIN: "0.01",
      FLY_MONTHLY_COST: "5",
    });
    const d = await svc.getUsage();
    expect(d.fly.appName).toBe("other-app");
    expect(d.deepgramRatePerMin).toBe(0.01);
    expect(d.fly.monthlyCostUsd).toBe(5);
  });

  it("caches results within the TTL and refetches after it", async () => {
    const { svc, fetchImpl, nowMs } = service(FULL_ENV);
    await svc.getUsage();
    const callsAfterFirst = fetchImpl.mock.calls.length;
    await svc.getUsage();
    expect(fetchImpl.mock.calls.length).toBe(callsAfterFirst); // cached
    nowMs.t += 300_001;
    await svc.getUsage();
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(callsAfterFirst); // expired
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd backend && npx vitest run src/usageService.test.ts`
Expected: FAIL — `Cannot find module './usageService'` (or equivalent).

- [ ] **Step 3: Implement `usageService.ts`**

```typescript
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
    const res = await fetchImpl(`${DEEPGRAM_API}/projects/${pid}/usage?start=${start}&end=${end}`, { headers });
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
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd backend && npx vitest run src/usageService.test.ts`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/src/usageService.ts backend/src/usageService.test.ts
git commit -m "feat: usage service with Deepgram/Fly fetch and 5min cache"
```

---

### Task 2: `GET /v1/usage` endpoint

**Files:**
- Modify: `backend/src/server.ts` (add `usage` to `StartServerOptions`, route in `handleRequest`)
- Test: `backend/src/server.usage.test.ts` (new)

**Interfaces:**
- Consumes: `UsageService` type from Task 1 (`{ getUsage(): Promise<ReportData> }`).
- Produces: `StartServerOptions.usage?: UsageService`; `GET /v1/usage?token=…` → 200 `ReportData` JSON, 401 bad token, 404 when `usage` option absent. Task 3 wires it; Task 5's client decodes this JSON.

- [ ] **Step 1: Write failing tests**

`backend/src/server.usage.test.ts` (follow the existing HTTP-test style in `server.http.test.ts` — start a real server on port 0, fetch against it):

```typescript
import { describe, it, expect, afterEach } from "vitest";
import { AddressInfo } from "net";
import { startServer, CaptionServer } from "./server";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";
import type { ReportData } from "./usageReport";

const REPORT: ReportData = {
  rangeStart: "2026-06-29",
  rangeEnd: "2026-07-06",
  deepgram: { hours: 1, requests: 4 },
  deepgramRatePerMin: 0.0077,
  fly: { appName: "watch-captions-relay", machines: [], monthlyCostUsd: 1.94 },
};

let server: CaptionServer;
afterEach(async () => {
  await server?.close();
});

function base(): string {
  const addr = server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}

function start(usage?: { getUsage(): Promise<ReportData> }) {
  server = startServer({
    port: 0,
    authToken: "secret",
    createProvider: () => new FakeTranscriptionProvider(),
    usage,
  });
}

describe("GET /v1/usage", () => {
  it("returns the report as JSON with a valid token", async () => {
    start({ getUsage: async () => REPORT });
    const res = await fetch(`${base()}/v1/usage?token=secret`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(REPORT);
  });

  it("rejects a bad token", async () => {
    start({ getUsage: async () => REPORT });
    const res = await fetch(`${base()}/v1/usage?token=wrong`);
    expect(res.status).toBe(401);
  });

  it("404s when usage is not configured", async () => {
    start(undefined);
    const res = await fetch(`${base()}/v1/usage?token=secret`);
    expect(res.status).toBe(404);
  });

  it("500s when the service throws", async () => {
    start({ getUsage: async () => { throw new Error("boom"); } });
    const res = await fetch(`${base()}/v1/usage?token=secret`);
    expect(res.status).toBe(500);
  });
});
```

Note: check `fakeTranscriptionProvider.ts` for the real export name/constructor before writing — mirror whatever `server.http.test.ts` uses to build providers.

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd backend && npx vitest run src/server.usage.test.ts`
Expected: FAIL — usage option not accepted / 404 on first test.

- [ ] **Step 3: Implement route**

In `server.ts`:

Add to `StartServerOptions`:

```typescript
  /** Optional usage data source; enables GET /v1/usage. */
  usage?: { getUsage(): Promise<import("./usageReport").ReportData> };
```

(Use a top-level `import type { ReportData } from "./usageReport";` instead of the inline import if preferred.)

In `handleRequest`, after the transcripts block and before the audio/stop block:

```typescript
  if (req.method === "GET" && url.pathname === "/v1/usage") {
    if (!opts.usage) {
      sendJSON(res, 404, { error: "usage not enabled" });
      return;
    }
    const token = url.searchParams.get("token") ?? undefined;
    if (!verifyToken(token, opts.authToken)) {
      sendJSON(res, 401, { error: "unauthorized" });
      return;
    }
    try {
      sendJSON(res, 200, await opts.usage.getUsage());
    } catch {
      sendJSON(res, 500, { error: "usage fetch failed" });
    }
    return;
  }
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd backend && npx vitest run src/server.usage.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Run full backend suite**

Run: `cd backend && npm test`
Expected: all pass (existing 40+ plus new).

- [ ] **Step 6: Commit**

```bash
git add backend/src/server.ts backend/src/server.usage.test.ts
git commit -m "feat: GET /v1/usage endpoint on the relay"
```

---

### Task 3: Wire service in index.ts

**Files:**
- Modify: `backend/src/index.ts`

**Interfaces:**
- Consumes: `createUsageService` (Task 1), `usage` server option (Task 2).
- Produces: prod relay serves `/v1/usage`. No new required config — service reads optional envs directly; `loadConfig` unchanged (keys are optional, validation-free).

- [ ] **Step 1: Wire it**

In `index.ts`, add import and pass the service:

```typescript
import { createUsageService } from "./usageService";
```

```typescript
const server = startServer({
  port: config.port,
  authToken: config.authToken,
  createProvider: (opts) =>
    new DeepgramProvider(
      deepgram,
      opts?.channels === 2 ? { channels: 2, multichannel: true } : undefined,
    ),
  transcripts,
  transcriptsDir: config.transcriptsDir,
  usage: createUsageService({ env: process.env }),
});
```

- [ ] **Step 2: Typecheck + full suite**

Run: `cd backend && npx tsc --noEmit && npm test`
Expected: clean, all pass.

- [ ] **Step 3: Commit**

```bash
git add backend/src/index.ts
git commit -m "feat: serve /v1/usage from the prod relay"
```

---

### Task 4: Delete email pipeline

**Files:**
- Delete: `.github/workflows/weekly-usage-report.yml`, `backend/src/usageReportCli.ts`
- Modify: `backend/src/usageReport.ts` (drop renderers), `backend/src/usageReport.test.ts` (drop renderer tests), `backend/package.json` (drop `usage-report` script), `backend/MONITORING.md` (rewrite)

**Interfaces:**
- Consumes: nothing new.
- Produces: `usageReport.ts` keeps ONLY `DeepgramUsage`, `FlyMachine`, `ReportData`, `lastWeekRange`, `summarizeDeepgram`, `estimateDeepgramCost`, `usd` (+ private `toUtcDate`/`num`). Tasks 1–3 depend on exactly these — do not remove them.

- [ ] **Step 1: Delete files and script**

```bash
git rm .github/workflows/weekly-usage-report.yml backend/src/usageReportCli.ts
```

In `backend/package.json` remove the line: `"usage-report": "tsx src/usageReportCli.ts",`

- [ ] **Step 2: Trim `usageReport.ts`**

Delete `reportSubject`, `renderTextReport`, `renderHtmlReport`, `renderMarkdownReport`, and `escapeHtml`. Keep everything above them (types, `lastWeekRange`, `toUtcDate`, `summarizeDeepgram`, `estimateDeepgramCost`, `usd`, `num`). Update the file header comment: helpers now back `/v1/usage`, not a weekly email.

- [ ] **Step 3: Trim `usageReport.test.ts`**

Remove the imports of the deleted functions and every `describe`/`it` that exercises `reportSubject`, `renderTextReport`, `renderMarkdownReport`, or `renderHtmlReport`. Keep `lastWeekRange`, `summarizeDeepgram`, `estimateDeepgramCost`, `usd` tests.

- [ ] **Step 4: Rewrite `MONITORING.md`**

```markdown
# Cost & Usage Monitoring

Usage is on-demand: the mac app's **Usage…** menu item (or any client) calls
`GET /v1/usage?token=<AUTH_TOKEN>` on the relay, which reports:

- **Deepgram** — last 7 days of streamed audio (hours, requests) and an
  estimated cost (hours × 60 × rate, default $0.0077/min for `nova-2`).
- **Fly.io** — machine list/status for the relay app and the fixed monthly
  estimate (~$1.94 for one always-on `shared-cpu-1x`).

Results are cached in-process for 5 minutes.

## Setup (Fly secrets — all optional)

| Secret / env             | What it is                                                          |
| ------------------------ | ------------------------------------------------------------------- |
| `DEEPGRAM_USAGE_API_KEY` | Deepgram key with **Usage: Read** scope (separate from the transcription key). Without it the Deepgram section reads "not set". |
| `DEEPGRAM_PROJECT_ID`    | Optional; pins the project. Defaults to the key's first project.     |
| `FLY_API_TOKEN`          | `fly tokens create readonly -o <org>` — enables live machine status. |
| `FLY_APP_NAME`           | Default `watch-captions-relay`.                                      |
| `DEEPGRAM_RATE_PER_MIN`  | Default `0.0077`.                                                    |
| `FLY_MONTHLY_COST`       | Default `1.94`.                                                      |

```bash
cd backend
fly secrets set DEEPGRAM_USAGE_API_KEY=<key> FLY_API_TOKEN=<token>
```

Missing keys or upstream errors never fail the endpoint — the affected
section comes back `null` with a reason string.

## Test it

```bash
curl "https://watch-captions-relay.fly.dev/v1/usage?token=$AUTH_TOKEN" | jq
```

## History

The weekly email report (GitHub Actions + Gmail SMTP) was removed 2026-07-06
in favor of this endpoint. If the old GitHub repo secrets are still set,
delete them: `MAIL_USERNAME`, `MAIL_PASSWORD`, `DEEPGRAM_USAGE_API_KEY`,
`DEEPGRAM_PROJECT_ID`, `FLY_API_TOKEN`, and the `REPORT_EMAIL_TO` variable.
```

- [ ] **Step 5: Verify**

Run: `cd backend && npx tsc --noEmit && npm test`
Expected: clean; suite passes with renderer tests gone.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat!: remove weekly usage email in favor of /v1/usage"
```

---

### Task 5: Mac RelayAPI usage fetch

**Files:**
- Modify: `mac/MacCaptions/RelayAPI.swift`

**Interfaces:**
- Consumes: `/v1/usage` JSON (Task 2) — `ReportData` shape.
- Produces: `RelayAPI.usage() async throws -> UsageReport`; types `UsageReport`, `UsageDeepgram`, `UsageFly`, `UsageFlyMachine` used by Task 6's view.

- [ ] **Step 1: Add decode types + method**

Append to `RelayAPI.swift` (top-level types, matching the existing style):

```swift
struct UsageDeepgram: Codable {
    let hours: Double
    let requests: Int
}

struct UsageFlyMachine: Codable, Identifiable {
    let id: String
    let state: String
    let region: String
}

struct UsageFly: Codable {
    let appName: String
    let machines: [UsageFlyMachine]?
    let machinesError: String?
    let monthlyCostUsd: Double
}

struct UsageReport: Codable {
    let rangeStart: String
    let rangeEnd: String
    let deepgram: UsageDeepgram?
    let deepgramError: String?
    let deepgramRatePerMin: Double
    let fly: UsageFly

    var estimatedDeepgramCost: Double? {
        deepgram.map { $0.hours * 60 * deepgramRatePerMin }
    }
}
```

And inside `struct RelayAPI`:

```swift
    func usage() async throws -> UsageReport {
        try await get(path: "v1/usage", as: UsageReport.self)
    }
```

- [ ] **Step 2: Build**

Run: `cd mac && xcodebuild build -project MacCaptions.xcodeproj -scheme MacCaptions -destination 'platform=macOS' -quiet; echo exit=$?`
Expected: `exit=0`.

- [ ] **Step 3: Commit**

```bash
git add mac/MacCaptions/RelayAPI.swift
git commit -m "feat: relay usage fetch in mac RelayAPI"
```

---

### Task 6: UsageView + menu item + window

**Files:**
- Create: `mac/MacCaptions/UsageView.swift`
- Modify: `mac/MacCaptions/MacCaptionsApp.swift`

**Interfaces:**
- Consumes: `RelayAPI.usage()`, `UsageReport` (Task 5); `model.settings.configured` / `relayURL` / `token` (existing).
- Produces: user-facing Usage… menu item and window.

- [ ] **Step 1: Create `UsageView.swift`**

```swift
import SwiftUI

struct UsageView: View {
    let api: RelayAPI?
    @State private var report: UsageReport?
    @State private var error: String?
    @State private var loading = false

    var body: some View {
        Group {
            if api == nil {
                Text("Set the relay URL and token in Settings.")
                    .foregroundStyle(.secondary)
            } else if let error {
                VStack(spacing: 8) {
                    Text(error).foregroundStyle(.red)
                    Button("Retry") { Task { await refresh() } }
                }
            } else if let r = report {
                content(r)
            } else {
                ProgressView()
            }
        }
        .frame(minWidth: 380, minHeight: 300)
        .task { await refresh() }
    }

    private func content(_ r: UsageReport) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("Week of \(r.rangeStart) → \(r.rangeEnd) (UTC)")
                    .font(.headline)

                Text("Deepgram — variable cost").font(.title3.bold())
                if let dg = r.deepgram {
                    row("Audio transcribed",
                        String(format: "%.2f h (%.1f min)", dg.hours, dg.hours * 60))
                    row("Requests", "\(dg.requests)")
                    if let cost = r.estimatedDeepgramCost {
                        row("Est. cost", String(format: "~$%.2f (@ $%g/min)", cost, r.deepgramRatePerMin))
                    }
                } else {
                    Text("Unavailable — \(r.deepgramError ?? "unknown")")
                        .foregroundStyle(.secondary)
                }

                Divider()

                Text("Fly.io — fixed cost").font(.title3.bold())
                row("App", r.fly.appName)
                if let machines = r.fly.machines {
                    if machines.isEmpty {
                        row("Machines", "none found")
                    } else {
                        ForEach(machines) { m in
                            row("Machine", "\(m.id) [\(m.state) · \(m.region)]")
                        }
                    }
                } else {
                    Text("Machines unavailable — \(r.fly.machinesError ?? "unknown")")
                        .foregroundStyle(.secondary)
                }
                row("Est. cost", String(format: "~$%.2f/month (always-on machine)", r.fly.monthlyCostUsd))

                Text("Estimates only — confirm at console.deepgram.com and fly.io/dashboard.")
                    .font(.caption).foregroundStyle(.secondary)

                Button("Refresh") { Task { await refresh() } }
                    .disabled(loading)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack(alignment: .top) {
            Text(label).foregroundStyle(.secondary).frame(width: 140, alignment: .leading)
            Text(value).textSelection(.enabled)
        }
        .font(.body)
    }

    private func refresh() async {
        guard let api else { return }
        loading = true
        defer { loading = false }
        do {
            report = try await api.usage()
            error = nil
        } catch {
            self.error = "\(error)"
        }
    }
}
```

- [ ] **Step 2: Menu item + window scene**

In `MacCaptionsApp.swift`, add above the Transcripts… button:

```swift
            Button("Usage…") {
                NSApp.activate(ignoringOtherApps: true)
                openWindow(id: "usage")
            }
```

Add after the Transcripts `Window` scene:

```swift
        Window("Usage", id: "usage") {
            UsageView(api: model.settings.configured
                ? RelayAPI(base: model.settings.relayURL!, token: model.settings.token)
                : nil)
        }
        .defaultSize(width: 420, height: 360)
```

- [ ] **Step 3: Regenerate project + build**

Run: `cd mac && xcodegen generate && xcodebuild build -project MacCaptions.xcodeproj -scheme MacCaptions -destination 'platform=macOS' -quiet; echo exit=$?`
Expected: `exit=0`. (xcodegen needed — new source file.)

- [ ] **Step 4: Commit**

```bash
git add mac/MacCaptions/UsageView.swift mac/MacCaptions/MacCaptionsApp.swift
git commit -m "feat: Usage window in mac menu bar app"
```

---

### Task 7: End-to-end verify

**Files:** none (verification only)

- [ ] **Step 1: Backend suite + typecheck**

Run: `cd backend && npx tsc --noEmit && npm test`
Expected: all green.

- [ ] **Step 2: Local relay smoke**

Run:
```bash
cd backend && AUTH_TOKEN=dev DEEPGRAM_API_KEY=x PORT=8199 npm run dev &
sleep 2
curl -s "http://localhost:8199/v1/usage?token=dev" | head -c 400; echo
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:8199/v1/usage?token=bad"
kill %1
```
Expected: JSON with `"deepgramError":"DEEPGRAM_USAGE_API_KEY not set"` and `"machinesError":"FLY_API_TOKEN not set"`; second curl prints `401`.

- [ ] **Step 3: Mac app manual check**

Relaunch the app; menu → Usage… opens a window in front. With the prod relay configured it shows real data (or "not set" reasons until Fly secrets are added).

- [ ] **Step 4: Deploy note (user action)**

`cd backend && fly deploy`, then optionally
`fly secrets set DEEPGRAM_USAGE_API_KEY=<key> FLY_API_TOKEN=<token>`.
