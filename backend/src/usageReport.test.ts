import { describe, it, expect } from "vitest";
import { lastWeekRange, usd } from "./usageReport";

describe("lastWeekRange", () => {
  it("returns a 7-day UTC window ending at now", () => {
    const { start, end } = lastWeekRange(new Date("2026-06-15T05:05:00Z"));
    expect(end).toBe("2026-06-15");
    expect(start).toBe("2026-06-08");
  });
});

describe("usd", () => {
  it("formats to two decimals", () => {
    expect(usd(1.5)).toBe("$1.50");
  });
});
