import { describe, it, expect, afterEach } from "vitest";
import { AddressInfo } from "net";
import { startServer, CaptionServer } from "./server";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";
import { IdentityStore } from "./identityStore";
import { openDb } from "./db";
import type { ReportData } from "./usageReport";

const REPORT: ReportData = {
  rangeStart: "2026-06-29",
  rangeEnd: "2026-07-06",
  fly: { appName: "watch-captions-relay", machines: [], monthlyCostUsd: 1.94 },
};

let running: CaptionServer | null = null;
let identity: IdentityStore;

afterEach(async () => {
  if (running) await running.close();
  running = null;
});

function start(usage?: { getUsage(): Promise<ReportData> }) {
  identity = new IdentityStore(openDb(":memory:"));
  running = startServer({
    port: 0,
    identity,
    adminToken: "admin-secret",
    createProvider: () => new FakeTranscriptionProvider(),
    usage,
  });
  const port = (running.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}`;
}

describe("GET /v1/usage", () => {
  it("returns the report as JSON with a valid token", async () => {
    const base = start({ getUsage: async () => REPORT });
    const res = await fetch(`${base}/v1/usage`, {
      headers: { authorization: "Bearer admin-secret" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(REPORT);
  });

  // The admin token is the system's only shared secret, and a query string
  // lands in every access log, proxy log and browser history between here and
  // the caller. Nothing on this route needs the query form — it is called by
  // tools that can set a header.
  it("refuses the admin token in the query string", async () => {
    const base = start({ getUsage: async () => REPORT });
    const res = await fetch(`${base}/v1/usage?token=admin-secret`);
    expect(res.status).toBe(401);
  });

  it("rejects a bad token", async () => {
    const base = start({ getUsage: async () => REPORT });
    const res = await fetch(`${base}/v1/usage`, {
      headers: { authorization: "Bearer wrong" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects a device token", async () => {
    const base = start({ getUsage: async () => REPORT });
    const registered = identity.registerDevice("mac");
    const res = await fetch(`${base}/v1/usage`, {
      headers: { authorization: `Bearer ${registered.token}` },
    });
    expect(res.status).toBe(401);
  });

  it("closes the endpoint when no admin token is configured", async () => {
    identity = new IdentityStore(openDb(":memory:"));
    running = startServer({
      port: 0,
      identity,
      createProvider: () => new FakeTranscriptionProvider(),
      usage: { getUsage: async () => REPORT },
    });
    const port = (running.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/v1/usage`, {
      headers: { authorization: "Bearer admin-secret" },
    });
    expect(res.status).toBe(401);
  });

  it("404s when usage is not configured", async () => {
    const base = start(undefined);
    const res = await fetch(`${base}/v1/usage`, {
      headers: { authorization: "Bearer admin-secret" },
    });
    expect(res.status).toBe(404);
  });

  it("500s when the service throws", async () => {
    const base = start({
      getUsage: async () => {
        throw new Error("boom");
      },
    });
    const res = await fetch(`${base}/v1/usage`, {
      headers: { authorization: "Bearer admin-secret" },
    });
    expect(res.status).toBe(500);
  });
});
