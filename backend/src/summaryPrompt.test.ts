import { describe, it, expect } from "vitest";
import { parseSummary, SUMMARY_SYSTEM_PROMPT } from "./summaryPrompt";

describe("parseSummary", () => {
  it("splits a leading Title: line off the body", () => {
    const raw = "Title: Vendor call about code review\n\nAn overview.\n- a point";

    const { title, body } = parseSummary(raw);

    expect(title).toBe("Vendor call about code review");
    expect(body).toBe("An overview.\n- a point");
  });

  it("leaves summaries written before titles existed untouched", () => {
    const raw = "An overview.\n- a point";

    const { title, body } = parseSummary(raw);

    expect(title).toBeUndefined();
    expect(body).toBe(raw);
  });

  it("tolerates a bold or markdown-styled title line", () => {
    expect(parseSummary("**Title:** A chat\n\nBody.").title).toBe("A chat");
    expect(parseSummary("## Title: A chat\n\nBody.").title).toBe("A chat");
  });

  it("ignores a Title: that appears further down, not as the first line", () => {
    const raw = "An overview.\n\nTitle: not really a title";

    expect(parseSummary(raw).title).toBeUndefined();
    expect(parseSummary(raw).body).toBe(raw);
  });

  it("treats an empty title as absent rather than an empty string", () => {
    const { title, body } = parseSummary("Title:   \n\nAn overview.");

    expect(title).toBeUndefined();
    expect(body).toBe("An overview.");
  });

  it("trims a title that runs long, so it stays usable as a page name", () => {
    const long = "x".repeat(200);

    const { title } = parseSummary(`Title: ${long}\n\nBody.`);

    expect(title!.length).toBeLessThanOrEqual(120);
  });

  it("asks the model for a title in the system prompt", () => {
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/Title:/);
  });

  it("asks for one section per topic rather than a flat bullet list", () => {
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/one section per topic/);
  });

  it("tells the model to cover the whole recording, not just the opening", () => {
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/middle and end/);
  });
});
