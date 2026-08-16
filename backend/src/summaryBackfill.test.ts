import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { backfillSummaries } from "./summaryBackfill";
import { ResolveExporters } from "./finalizer";
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

/** Wraps a `patchSummary` fn into the `resolve` shape `backfillSummaries` now takes, for user `U`. */
function resolveWith(patchSummary: (pageId: string, summary: string) => Promise<void>): ResolveExporters {
  return (userId) =>
    userId === U
      ? {
          export: async () => ({ pageId: "p1", url: "u" }),
          update: async () => ({ pageId: "p1", url: "u", exportedSegments: 0 }),
          patchSummary,
        }
      : undefined;
}

/** A user with no Notion connection at all. */
const noConnection: ResolveExporters = () => undefined;

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

  it("re-summarizes an already-summarized transcript under force", async () => {
    const name = storeSession(root, "s1", 1000);
    writeSummary(scoped(root), name, "an existing summary");
    const summarize = summarizer();

    const result = await backfillSummaries({
      dir: scoped(root),
      userId: U,
      summarize,
      force: true,
      delayMs: 0,
    });

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(result.summarized).toBe(1);
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

  it("counts a failed model call against the limit", async () => {
    storeSession(root, "s1", 1000);
    storeSession(root, "s2", 2000);
    const summarize = vi.fn(async () => {
      throw new Error("token ceiling");
    });

    const result = await backfillSummaries({
      dir: scoped(root),
      userId: U,
      summarize,
      limit: 1,
      delayMs: 0,
    });

    // A limit bounding successes would keep walking the archive looking for
    // a success that never comes, spending a paid call on every transcript.
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(result.failed).toBe(1);
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
      resolve: resolveWith(patchPage),
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
      resolve: resolveWith(patchPage),
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
      resolve: resolveWith(patchPage),
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

  // A user with no Notion connection still wants their summaries generated
  // and written to disk — that is local work with nothing to do with Notion.
  // Unlike `backfillNotion`, `backfillSummaries` must not bail out early on
  // a missing connection.
  it("still summarizes for a user with no Notion connection", async () => {
    const name = storeSession(root, "abc", Date.UTC(2026, 6, 6, 1, 2, 3));
    const summarize = summarizer();

    const result = await backfillSummaries({
      dir: scoped(root),
      userId: U,
      summarize,
      delayMs: 0,
      resolve: noConnection,
    });

    expect(summarize).toHaveBeenCalledOnce();
    expect(result.summarized).toBe(1);
    expect(readTranscript(scoped(root), name)?.summary).toBe("A chat happened.");
  });

  it("does not patch an already-exported page for a user with no Notion connection", async () => {
    const name = storeSession(root, "abc", Date.UTC(2026, 6, 6, 1, 2, 3));
    writeExportMarker(scoped(root), name, { pageId: "page-1", url: "u" });

    const result = await backfillSummaries({
      dir: scoped(root),
      userId: U,
      summarize: summarizer(),
      delayMs: 0,
      resolve: noConnection,
    });

    expect(result).toMatchObject({ summarized: 1, patched: 0 });
  });

  it("omitting resolve entirely still summarizes without patching", async () => {
    const name = storeSession(root, "abc", Date.UTC(2026, 6, 6, 1, 2, 3));
    const summarize = summarizer();

    const result = await backfillSummaries({ dir: scoped(root), userId: U, summarize, delayMs: 0 });

    expect(result.summarized).toBe(1);
    expect(result.patched).toBe(0);
    expect(readTranscript(scoped(root), name)?.summary).toBe("A chat happened.");
  });

  // A sealed secret that fails to open (rotated key, restored database) must
  // not stop this user's own summaries from being generated and written to
  // disk — only the Notion patch step, which needs it, is affected.
  it("still summarizes when resolve throws for this user", async () => {
    const name = storeSession(root, "abc", Date.UTC(2026, 6, 6, 1, 2, 3));
    const summarize = summarizer();
    const resolve: ResolveExporters = () => {
      throw new Error("bad auth tag");
    };

    const result = await backfillSummaries({ dir: scoped(root), userId: U, summarize, delayMs: 0, resolve });

    expect(summarize).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ summarized: 1, patched: 0 });
    expect(readTranscript(scoped(root), name)?.summary).toBe("A chat happened.");
  });

  it("does not let one user's throwing resolve stop the sweep for the next user in the loop", async () => {
    // Mirrors what `runBackfills` in index.ts does: call `backfillSummaries`
    // once per user directory, in a loop, sharing one `resolve`.
    const bad = "user-bad";
    const good = "user-good";
    const store = new TranscriptStore({ root, now: () => Date.UTC(2026, 6, 6, 1, 2, 3) });
    store.append(bad, "s1", LONG);
    store.append(good, "s2", LONG);
    const goodName = listTranscripts(userDir(root, good))[0].name;

    const patchSummary = vi.fn(async () => {});
    writeExportMarker(userDir(root, good), goodName, { pageId: "page-1", url: "u" });
    const resolve: ResolveExporters = (userId) => {
      if (userId === bad) throw new Error("bad auth tag");
      if (userId === good) {
        return {
          export: async () => ({ pageId: "p1", url: "u" }),
          update: async () => ({ pageId: "p1", url: "u", exportedSegments: 0 }),
          patchSummary,
        };
      }
      return undefined;
    };
    const summarize = summarizer();

    const results = [];
    for (const userId of [bad, good]) {
      results.push(
        await backfillSummaries({ dir: userDir(root, userId), userId, summarize, delayMs: 0, resolve }),
      );
    }

    expect(results[0]).toMatchObject({ summarized: 1, patched: 0 });
    expect(results[1]).toMatchObject({ summarized: 1, patched: 1 });
    expect(patchSummary).toHaveBeenCalledWith("page-1", "A chat happened.");
  });
});
