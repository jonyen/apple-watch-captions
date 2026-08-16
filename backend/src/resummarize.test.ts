import { describe, expect, it } from "vitest";
import { parseArgs } from "./resummarize";

describe("parseArgs", () => {
  it("reads --last N", () => {
    expect(parseArgs(["--last", "20"])).toEqual({ last: 20 });
  });

  it("accepts --last=N", () => {
    expect(parseArgs(["--last=5"])).toEqual({ last: 5 });
  });

  it("refuses to run without --last rather than defaulting to everything", () => {
    expect(() => parseArgs([])).toThrow(/--last is required/);
  });

  it("rejects a non-positive count", () => {
    expect(() => parseArgs(["--last", "0"])).toThrow(/positive integer/);
  });
});
