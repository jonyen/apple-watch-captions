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
