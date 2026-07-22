import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createFinalizer } from "./finalizer";
import { notionPageIdFor } from "./notionSync";
import { FinalizedTranscript, readTranscript, TranscriptStore, listTranscripts } from "./transcriptStore";

function transcript(texts: string[]): FinalizedTranscript {
  return {
    name: "2026-07-06T01-02-03Z_abc",
    sessionId: "abc",
    startedAt: "2026-07-06T01:02:03Z",
    endedAt: "2026-07-06T01:05:03Z",
    segments: texts.map((text, i) => ({ at: `2026-07-06T01:02:0${i}Z`, text })),
  };
}

const LONG = ["this is a reasonably long caption about something", "and another one"];
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("createFinalizer", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "finalizer-"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("stores the summary next to the transcript", async () => {
    const store = new TranscriptStore({ dir, now: () => Date.UTC(2026, 6, 6, 1, 2, 3) });
    store.append("abc", LONG[0]);
    const name = listTranscripts(dir)[0].name;

    const finalize = createFinalizer({ dir, summarize: async () => "A chat happened." });
    finalize({ ...transcript(LONG), name });
    await settle();

    expect(readTranscript(dir, name)?.summary).toBe("A chat happened.");
  });

  it("skips near-empty transcripts", async () => {
    const summarize = vi.fn(async () => "s");
    createFinalizer({ dir, summarize })(transcript(["hi"]));
    await settle();
    expect(summarize).not.toHaveBeenCalled();
  });

  it("survives a failing summarizer", async () => {
    const finalize = createFinalizer({
      dir,
      summarize: async () => {
        throw new Error("api down");
      },
    });
    expect(() => finalize(transcript(LONG))).not.toThrow();
    await settle();
  });

  it("syncs to Notion with the generated summary and records the page", async () => {
    const notionSync = vi.fn(async () => "page-1");
    const finalize = createFinalizer({ dir, summarize: async () => "A chat happened.", notionSync });
    const t = transcript(LONG);
    finalize(t);
    await settle();

    expect(notionSync).toHaveBeenCalledWith(t, "A chat happened.");
    expect(notionPageIdFor(dir, t.name)).toBe("page-1");
  });

  it("syncs to Notion without a summary when no summarizer is configured", async () => {
    const notionSync = vi.fn(async () => "page-2");
    createFinalizer({ dir, notionSync })(transcript(["hi"]));
    await settle();

    expect(notionSync).toHaveBeenCalledWith(expect.anything(), null);
  });

  it("still summarizes when the Notion sync fails", async () => {
    const store = new TranscriptStore({ dir, now: () => Date.UTC(2026, 6, 6, 1, 2, 3) });
    store.append("abc", LONG[0]);
    const name = listTranscripts(dir)[0].name;

    const finalize = createFinalizer({
      dir,
      summarize: async () => "Summary survives.",
      notionSync: async () => {
        throw new Error("notion down");
      },
    });
    expect(() => finalize({ ...transcript(LONG), name })).not.toThrow();
    await settle();

    expect(readTranscript(dir, name)?.summary).toBe("Summary survives.");
    expect(notionPageIdFor(dir, name)).toBeNull();
  });
});
