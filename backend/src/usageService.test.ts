import { describe, it, expect, vi } from "vitest";
import { createUsageService } from "./usageService";

const FLY_MACHINES = [{ id: "m1", state: "started", region: "ord" }];

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

/** fetchImpl serving the Fly machines endpoint. */
function fakeFetch(overrides: Record<string, () => Response> = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [substr, make] of Object.entries(overrides)) {
      if (url.includes(substr)) return make();
    }
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

const FULL_ENV = { FLY_API_TOKEN: "ft" };

describe("createUsageService", () => {
  it("returns the Fly section on the happy path", async () => {
    const { svc } = service(FULL_ENV);
    const d = await svc.getUsage();
    expect(d.fly.machines).toEqual([{ id: "m1", state: "started", region: "ord" }]);
    expect(d.fly.appName).toBe("watch-captions-relay");
    expect(d.fly.monthlyCostUsd).toBe(1.94);
  });

  it("nulls machines with reason when the token is missing", async () => {
    const { svc } = service({});
    const d = await svc.getUsage();
    expect(d.fly.machines).toBeNull();
    expect(d.fly.machinesError).toBe("FLY_API_TOKEN not set");
  });

  it("reports an upstream failure with a reason rather than failing the endpoint", async () => {
    const fetchImpl = fakeFetch({ "/machines": () => new Response("no", { status: 403 }) });
    const { svc } = service(FULL_ENV, fetchImpl);
    const d = await svc.getUsage();
    expect(d.fly.machines).toBeNull();
    expect(d.fly.machinesError).toContain("403");
  });

  it("honors env overrides for app name and monthly cost", async () => {
    const { svc } = service({
      ...FULL_ENV,
      FLY_APP_NAME: "other-app",
      FLY_MONTHLY_COST: "5",
    });
    const d = await svc.getUsage();
    expect(d.fly.appName).toBe("other-app");
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
