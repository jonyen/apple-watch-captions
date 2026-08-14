import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { backfillSummaries } from "./summaryBackfill";
import {
  TranscriptStore,
  FinalizedTranscript,
  listTranscripts,
  readTranscript,
  writeSummary,
  writeExportMarker,
  userDir,
} from "./transcriptStore";

const LONG = "this is a reasonably long caption about something in particular";
/**
 * A single fixed user. `backfillSummaries` still sweeps one directory handed
 * to it by its caller (Task 12 moves callers onto per-user directories);
 * these tests exercise it against `userDir(root, U)`, standing in for
 * whatever directory it is eventually pointed at.
 */
const U = "user-1";
const scoped = (root: string) => userDir(root, U);

function storeSession(root: string, id: string, at: number, texts: string[] = [LONG]): string {
  const store = new TranscriptStore({ root, now: () => at });
  for (const text of texts) store.append(U, id, text);
  return listTranscripts(scoped(root)).find((t) => t.name.endsWith(`_${id}`))!.name;
}

const summarizer = () => vi.fn(async (_t: FinalizedTranscript) => "A chat happened.");

describe("backfillSummaries", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sumbackfill-"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("summarizes transcripts that have no summary yet", async () => {
    const name = storeSession(root, "abc", Date.UTC(2026, 6, 6, 1, 2, 3));
    const summarize = summarizer();

    const result = await backfillSummaries({ dir: scoped(root), userId: U, summarize, delayMs: 0 });

    expect(summarize).toHaveBeenCalledOnce();
    expect(result.summarized).toBe(1);
    expect(readTranscript(scoped(root), name)?.summary).toBe("A chat happened.");
  });

  it("passes the stored segments to the summarizer", async () => {
    storeSession(root, "abc", Date.UTC(2026, 6, 6, 1, 2, 3), [LONG, "second line"]);
    const summarize = summarizer();

    await backfillSummaries({ dir: scoped(root), userId: U, summarize, delayMs: 0 });

    const sent = summarize.mock.calls[0][0];
    expect(sent.sessionId).toBe("abc");
    expect(sent.segments.map((s) => s.text)).toEqual([LONG, "second line"]);
    // The sweep runs per user directory, so it knows the owner. Rebuilding
    // without one leaves `userId` empty — harmless while nothing downstream
    // reads it, and a trap for the per-user export work that will.
    expect(sent.userId).toBe(U);
  });

  it("skips transcripts that already have a summary", async () => {
    const name = storeSession(root, "abc", Date.UTC(2026, 6, 6, 1, 2, 3));
    writeSummary(scoped(root), name, "already done");
    const summarize = summarizer();

    const result = await backfillSummaries({ dir: scoped(root), userId: U, summarize, delayMs: 0 });

    expect(summarize).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    expect(readTranscript(scoped(root), name)?.summary).toBe("already done");
  });

  it("skips near-empty transcripts", async () => {
    storeSession(root, "abc", Date.UTC(2026, 6, 6, 1, 2, 3), ["hi"]);
    const summarize = summarizer();

    const result = await backfillSummaries({ dir: scoped(root), userId: U, summarize, delayMs: 0 });

    expect(summarize).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it("keeps going after a failed summarize and reports it", async () => {
    storeSession(root, "aaa", Date.UTC(2026, 6, 6, 1, 0, 0));
    storeSession(root, "bbb", Date.UTC(2026, 6, 6, 2, 0, 0));
    let calls = 0;
    const summarize = vi.fn(async () => {
      if (++calls === 1) throw new Error("credit balance too low");
      return "A chat happened.";
    });

    const result = await backfillSummaries({ dir: scoped(root), userId: U, summarize, delayMs: 0 });

    expect(summarize).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ summarized: 1, failed: 1 });
  });

  it("writes no summary file when the summarizer returns empty text", async () => {
    const name = storeSession(root, "abc", Date.UTC(2026, 6, 6, 1, 2, 3));
    const summarize = vi.fn(async () => "");

    const result = await backfillSummaries({ dir: scoped(root), userId: U, summarize, delayMs: 0 });

    expect(readTranscript(scoped(root), name)?.summary).toBeNull();
    expect(result.failed).toBe(1);
  });

  it("stops after the requested limit", async () => {
    storeSession(root, "aaa", Date.UTC(2026, 6, 6, 1, 0, 0));
    storeSession(root, "bbb", Date.UTC(2026, 6, 6, 2, 0, 0));
    storeSession(root, "ccc", Date.UTC(2026, 6, 6, 3, 0, 0));
    const summarize = summarizer();

    const result = await backfillSummaries({
      dir: scoped(root),
      userId: U,
      summarize,
      delayMs: 0,
      limit: 2,
    });

    expect(summarize).toHaveBeenCalledTimes(2);
    expect(result.summarized).toBe(2);
  });

  it("adds the new summary to a page that was already exported", async () => {
    const name = storeSession(root, "abc", Date.UTC(2026, 6, 6, 1, 2, 3));
    writeExportMarker(scoped(root), name, { pageId: "page-1", url: "u" });
    const patchPage = vi.fn(async (_pageId: string, _summary: string) => {});

    const result = await backfillSummaries({
      dir: scoped(root),
      userId: U,
      summarize: summarizer(),
      delayMs: 0,
      patchPage,
    });

    expect(patchPage).toHaveBeenCalledWith("page-1", "A chat happened.");
    expect(result.patched).toBe(1);
  });

  it("does not patch a transcript that was never exported", async () => {
    storeSession(root, "abc", Date.UTC(2026, 6, 6, 1, 2, 3));
    const patchPage = vi.fn(async () => {});

    const result = await backfillSummaries({
      dir: scoped(root),
      userId: U,
      summarize: summarizer(),
      delayMs: 0,
      patchPage,
    });

    expect(patchPage).not.toHaveBeenCalled();
    expect(result.patched).toBe(0);
  });

  it("keeps the summary on disk when patching the page fails", async () => {
    const name = storeSession(root, "abc", Date.UTC(2026, 6, 6, 1, 2, 3));
    writeExportMarker(scoped(root), name, { pageId: "page-1", url: "u" });
    const patchPage = vi.fn(async () => {
      throw new Error("notion down");
    });

    const result = await backfillSummaries({
      dir: scoped(root),
      userId: U,
      summarize: summarizer(),
      delayMs: 0,
      patchPage,
    });

    expect(readTranscript(scoped(root), name)?.summary).toBe("A chat happened.");
    expect(result).toMatchObject({ summarized: 1, patched: 0 });
  });

  it("paces requests", async () => {
    storeSession(root, "aaa", Date.UTC(2026, 6, 6, 1, 0, 0));
    storeSession(root, "bbb", Date.UTC(2026, 6, 6, 2, 0, 0));
    const waits: number[] = [];

    await backfillSummaries({
      dir: scoped(root),
      userId: U,
      summarize: summarizer(),
      delayMs: 500,
      sleep: async (ms: number) => {
        waits.push(ms);
      },
    });

    expect(waits).toEqual([500, 500]);
  });
});
