import { describe, it, expect } from "vitest";
import { lastWeekRange, summarizeDeepgram, estimateDeepgramCost, usd } from "./usageReport";

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

describe("usd", () => {
  it("formats to two decimals", () => {
    expect(usd(1.5)).toBe("$1.50");
  });
});
