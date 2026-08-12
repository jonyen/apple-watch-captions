import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "fs";
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
} from "./transcriptStore";

const LONG = "this is a reasonably long caption about something in particular";

function storeSession(dir: string, id: string, at: number, texts: string[] = [LONG]): string {
  const store = new TranscriptStore({ dir, now: () => at });
  for (const text of texts) store.append(id, text);
  return listTranscripts(dir).find((t) => t.name.endsWith(`_${id}`))!.name;
}

const summarizer = () => vi.fn(async (_t: FinalizedTranscript) => "A chat happened.");

describe("backfillSummaries", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sumbackfill-"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("summarizes transcripts that have no summary yet", async () => {
    const name = storeSession(dir, "abc", Date.UTC(2026, 6, 6, 1, 2, 3));
    const summarize = summarizer();

    const result = await backfillSummaries({ dir, summarize, delayMs: 0 });

    expect(summarize).toHaveBeenCalledOnce();
    expect(result.summarized).toBe(1);
    expect(readTranscript(dir, name)?.summary).toBe("A chat happened.");
  });

  it("passes the stored segments to the summarizer", async () => {
    storeSession(dir, "abc", Date.UTC(2026, 6, 6, 1, 2, 3), [LONG, "second line"]);
    const summarize = summarizer();

    await backfillSummaries({ dir, summarize, delayMs: 0 });

    const sent = summarize.mock.calls[0][0];
    expect(sent.sessionId).toBe("abc");
    expect(sent.segments.map((s) => s.text)).toEqual([LONG, "second line"]);
  });

  it("skips transcripts that already have a summary", async () => {
    const name = storeSession(dir, "abc", Date.UTC(2026, 6, 6, 1, 2, 3));
    writeSummary(dir, name, "already done");
    const summarize = summarizer();

    const result = await backfillSummaries({ dir, summarize, delayMs: 0 });

    expect(summarize).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    expect(readTranscript(dir, name)?.summary).toBe("already done");
  });

  it("skips near-empty transcripts", async () => {
    storeSession(dir, "abc", Date.UTC(2026, 6, 6, 1, 2, 3), ["hi"]);
    const summarize = summarizer();

    const result = await backfillSummaries({ dir, summarize, delayMs: 0 });

    expect(summarize).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it("keeps going after a failed summarize and reports it", async () => {
    storeSession(dir, "aaa", Date.UTC(2026, 6, 6, 1, 0, 0));
    storeSession(dir, "bbb", Date.UTC(2026, 6, 6, 2, 0, 0));
    let calls = 0;
    const summarize = vi.fn(async () => {
      if (++calls === 1) throw new Error("credit balance too low");
      return "A chat happened.";
    });

    const result = await backfillSummaries({ dir, summarize, delayMs: 0 });

    expect(summarize).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ summarized: 1, failed: 1 });
  });

  it("writes no summary file when the summarizer returns empty text", async () => {
    const name = storeSession(dir, "abc", Date.UTC(2026, 6, 6, 1, 2, 3));
    const summarize = vi.fn(async () => "");

    const result = await backfillSummaries({ dir, summarize, delayMs: 0 });

    expect(readTranscript(dir, name)?.summary).toBeNull();
    expect(result.failed).toBe(1);
  });

  it("stops after the requested limit", async () => {
    storeSession(dir, "aaa", Date.UTC(2026, 6, 6, 1, 0, 0));
    storeSession(dir, "bbb", Date.UTC(2026, 6, 6, 2, 0, 0));
    storeSession(dir, "ccc", Date.UTC(2026, 6, 6, 3, 0, 0));
    const summarize = summarizer();

    const result = await backfillSummaries({ dir, summarize, delayMs: 0, limit: 2 });

    expect(summarize).toHaveBeenCalledTimes(2);
    expect(result.summarized).toBe(2);
  });

  it("adds the new summary to a page that was already exported", async () => {
    const name = storeSession(dir, "abc", Date.UTC(2026, 6, 6, 1, 2, 3));
    writeExportMarker(dir, name, { pageId: "page-1", url: "u" });
    const patchPage = vi.fn(async (_pageId: string, _summary: string) => {});

    const result = await backfillSummaries({ dir, summarize: summarizer(), delayMs: 0, patchPage });

    expect(patchPage).toHaveBeenCalledWith("page-1", "A chat happened.");
    expect(result.patched).toBe(1);
  });

  it("does not patch a transcript that was never exported", async () => {
    storeSession(dir, "abc", Date.UTC(2026, 6, 6, 1, 2, 3));
    const patchPage = vi.fn(async () => {});

    const result = await backfillSummaries({ dir, summarize: summarizer(), delayMs: 0, patchPage });

    expect(patchPage).not.toHaveBeenCalled();
    expect(result.patched).toBe(0);
  });

  it("keeps the summary on disk when patching the page fails", async () => {
    const name = storeSession(dir, "abc", Date.UTC(2026, 6, 6, 1, 2, 3));
    writeExportMarker(dir, name, { pageId: "page-1", url: "u" });
    const patchPage = vi.fn(async () => {
      throw new Error("notion down");
    });

    const result = await backfillSummaries({ dir, summarize: summarizer(), delayMs: 0, patchPage });

    expect(readTranscript(dir, name)?.summary).toBe("A chat happened.");
    expect(result).toMatchObject({ summarized: 1, patched: 0 });
  });

  it("skips already-summarized transcripts by default", async () => {
    const names = [
      storeSession(dir, "aaa", Date.UTC(2026, 6, 6, 1, 0, 0)),
      storeSession(dir, "bbb", Date.UTC(2026, 6, 6, 2, 0, 0)),
      storeSession(dir, "ccc", Date.UTC(2026, 6, 6, 3, 0, 0)),
    ];
    for (const name of names) writeSummary(dir, name, "already done");
    const summarize = summarizer();

    const result = await backfillSummaries({ dir, summarize, delayMs: 0 });

    expect(summarize).not.toHaveBeenCalled();
    expect(result.summarized).toBe(0);
    expect(result.skipped).toBe(3);
  });

  it("regenerates already-summarized transcripts under force", async () => {
    const names = [
      storeSession(dir, "aaa", Date.UTC(2026, 6, 6, 1, 0, 0)),
      storeSession(dir, "bbb", Date.UTC(2026, 6, 6, 2, 0, 0)),
      storeSession(dir, "ccc", Date.UTC(2026, 6, 6, 3, 0, 0)),
    ];
    for (const name of names) writeSummary(dir, name, "already done");
    const summarize = summarizer();

    const result = await backfillSummaries({ dir, force: true, summarize, delayMs: 0 });

    expect(summarize).toHaveBeenCalledTimes(3);
    expect(result.summarized).toBe(3);
    expect(result.skipped).toBe(0);
  });

  it("under force with a limit, regenerates only the newest N", async () => {
    // backfillSummaries walks listTranscripts(dir) directly, which is already
    // newest-first, so a limit of 2 regenerates the two newest transcripts here
    // (ddd, eee) and never reaches ccc/bbb/aaa.
    const [aaa, bbb, ccc, ddd, eee] = [
      storeSession(dir, "aaa", Date.UTC(2026, 6, 6, 1, 0, 0)),
      storeSession(dir, "bbb", Date.UTC(2026, 6, 6, 2, 0, 0)),
      storeSession(dir, "ccc", Date.UTC(2026, 6, 6, 3, 0, 0)),
      storeSession(dir, "ddd", Date.UTC(2026, 6, 6, 4, 0, 0)),
      storeSession(dir, "eee", Date.UTC(2026, 6, 6, 5, 0, 0)),
    ];
    for (const name of [aaa, bbb, ccc, ddd, eee]) writeSummary(dir, name, "already done");

    const result = await backfillSummaries({
      dir,
      force: true,
      limit: 2,
      summarize: async () => "Regenerated.",
      delayMs: 0,
    });

    expect(result.summarized).toBe(2);
    const readSummaryFile = (name: string) => readFileSync(join(dir, `${name}.summary.md`), "utf8");
    // The two newest were regenerated.
    expect(readSummaryFile(ddd)).toBe("Regenerated.");
    expect(readSummaryFile(eee)).toBe("Regenerated.");
    // The three oldest still hold their original summary text, byte-for-byte.
    expect(readSummaryFile(aaa)).toBe("already done");
    expect(readSummaryFile(bbb)).toBe("already done");
    expect(readSummaryFile(ccc)).toBe("already done");
  });

  it("paces requests", async () => {
    storeSession(dir, "aaa", Date.UTC(2026, 6, 6, 1, 0, 0));
    storeSession(dir, "bbb", Date.UTC(2026, 6, 6, 2, 0, 0));
    const waits: number[] = [];

    await backfillSummaries({
      dir,
      summarize: summarizer(),
      delayMs: 500,
      sleep: async (ms: number) => {
        waits.push(ms);
      },
    });

    expect(waits).toEqual([500, 500]);
  });
});
