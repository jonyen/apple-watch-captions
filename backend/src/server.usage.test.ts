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

let running: CaptionServer | null = null;

afterEach(async () => {
  if (running) await running.close();
  running = null;
});

function start(usage?: { getUsage(): Promise<ReportData> }) {
  running = startServer({
    port: 0,
    authToken: "secret",
    createProvider: () => new FakeTranscriptionProvider(),
    usage,
  });
  const port = (running.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}`;
}

describe("GET /v1/usage", () => {
  it("returns the report as JSON with a valid token", async () => {
    const base = start({ getUsage: async () => REPORT });
    const res = await fetch(`${base}/v1/usage?token=secret`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(REPORT);
  });

  it("rejects a bad token", async () => {
    const base = start({ getUsage: async () => REPORT });
    const res = await fetch(`${base}/v1/usage?token=wrong`);
    expect(res.status).toBe(401);
  });

  it("404s when usage is not configured", async () => {
    const base = start(undefined);
    const res = await fetch(`${base}/v1/usage?token=secret`);
    expect(res.status).toBe(404);
  });

  it("500s when the service throws", async () => {
    const base = start({
      getUsage: async () => {
        throw new Error("boom");
      },
    });
    const res = await fetch(`${base}/v1/usage?token=secret`);
    expect(res.status).toBe(500);
  });
});
