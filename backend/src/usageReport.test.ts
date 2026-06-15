import { describe, it, expect } from "vitest";
import {
  lastWeekRange,
  summarizeDeepgram,
  estimateDeepgramCost,
  reportSubject,
  renderTextReport,
  renderMarkdownReport,
  usd,
  ReportData,
} from "./usageReport";

describe("lastWeekRange", () => {
  it("returns a 7-day UTC window ending at now", () => {
    const { start, end } = lastWeekRange(new Date("2026-06-15T05:05:00Z"));
    expect(end).toBe("2026-06-15");
    expect(start).toBe("2026-06-08");
  });
});

describe("summarizeDeepgram", () => {
  it("sums hours and requests across result rows", () => {
    const u = summarizeDeepgram({
      results: [
        { total_hours: 1.5, requests: 10 },
        { total_hours: 0.75, requests: 4 },
      ],
    });
    expect(u.hours).toBeCloseTo(2.25);
    expect(u.requests).toBe(14);
  });

  it("falls back to `hours` when `total_hours` is absent", () => {
    expect(summarizeDeepgram({ results: [{ hours: 2, requests: 1 }] }).hours).toBe(2);
  });

  it("is defensive against missing / malformed payloads", () => {
    expect(summarizeDeepgram(null)).toEqual({ hours: 0, requests: 0 });
    expect(summarizeDeepgram({})).toEqual({ hours: 0, requests: 0 });
    expect(summarizeDeepgram({ results: "nope" })).toEqual({ hours: 0, requests: 0 });
  });
});

describe("estimateDeepgramCost", () => {
  it("multiplies hours by minutes by rate", () => {
    expect(estimateDeepgramCost(1, 0.0077)).toBeCloseTo(0.462);
    expect(estimateDeepgramCost(0, 0.0077)).toBe(0);
  });
});

const sample: ReportData = {
  rangeStart: "2026-06-08",
  rangeEnd: "2026-06-15",
  deepgram: { hours: 2.25, requests: 14 },
  deepgramRatePerMin: 0.0077,
  fly: {
    appName: "watch-captions-relay",
    machines: [{ id: "abc123", state: "started", region: "sjc" }],
    monthlyCostUsd: 1.94,
  },
};

describe("reportSubject", () => {
  it("summarizes hours and cost", () => {
    expect(reportSubject(sample)).toBe(
      "Watch Captions weekly usage — 2.25h, ~$1.04 (week of 2026-06-08)",
    );
  });

  it("notes when Deepgram data is unavailable", () => {
    const s = reportSubject({ ...sample, deepgram: null });
    expect(s).toContain("Deepgram data unavailable");
  });
});

describe("renderTextReport", () => {
  it("includes both cost sections and the estimate", () => {
    const text = renderTextReport(sample);
    expect(text).toContain("Deepgram (variable cost)");
    expect(text).toContain("2.25 h");
    expect(text).toContain("~$1.04");
    expect(text).toContain("Fly.io (fixed cost)");
    expect(text).toContain("abc123 [started] in sjc");
    expect(text).toContain("~$1.94/month");
  });

  it("degrades gracefully when sources are unavailable", () => {
    const text = renderTextReport({
      ...sample,
      deepgram: null,
      fly: { ...sample.fly, machines: null },
    });
    expect(text).toContain("check DEEPGRAM_API_KEY");
    expect(text).toContain("status unavailable");
  });
});

describe("renderMarkdownReport", () => {
  it("renders both sections with the cost estimate", () => {
    const md = renderMarkdownReport(sample);
    expect(md).toContain("### Deepgram — variable cost");
    expect(md).toContain("**2.25 h**");
    expect(md).toContain("~$1.04");
    expect(md).toContain("### Fly.io — fixed cost");
    expect(md).toContain("`abc123` [started · sjc]");
  });

  it("degrades gracefully when sources are unavailable", () => {
    const md = renderMarkdownReport({
      ...sample,
      deepgram: null,
      fly: { ...sample.fly, machines: null },
    });
    expect(md).toContain("DEEPGRAM_API_KEY");
    expect(md).toContain("status unavailable");
  });
});

describe("usd", () => {
  it("formats to two decimals", () => {
    expect(usd(1.5)).toBe("$1.50");
  });
});
