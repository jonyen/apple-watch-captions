import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { backfillNotion } from "./notionBackfill";
import {
  TranscriptStore,
  FinalizedTranscript,
  listTranscripts,
  readExportMarker,
  writeExportMarker,
  writeSummary,
} from "./transcriptStore";

const LONG = "this is a reasonably long caption about something in particular";

/** Write a finished transcript to disk the way a real session would. */
function storeSession(dir: string, id: string, at: number, texts: string[] = [LONG]): string {
  const store = new TranscriptStore({ dir, now: () => at });
  for (const text of texts) store.append(id, text);
  return listTranscripts(dir).find((t) => t.name.endsWith(`_${id}`))!.name;
}

const ok = () => vi.fn(async (_t: FinalizedTranscript, _s: string | null) => ({
  pageId: "p1",
  url: "https://notion.so/p1",
}));

describe("backfillNotion", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "backfill-"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("exports stored transcripts that were never exported", async () => {
    const name = storeSession(dir, "abc", Date.UTC(2026, 6, 6, 1, 2, 3));
    const exportTranscript = ok();

    const result = await backfillNotion({ dir, export: exportTranscript, delayMs: 0 });

    expect(exportTranscript).toHaveBeenCalledOnce();
    expect(result.exported).toBe(1);
    expect(readExportMarker(dir, name)).toMatchObject({ pageId: "p1" });
  });

  it("reconstructs the transcript's segments and session id", async () => {
    storeSession(dir, "abc", Date.UTC(2026, 6, 6, 1, 2, 3), [LONG, "second line"]);
    const exportTranscript = ok();

    await backfillNotion({ dir, export: exportTranscript, delayMs: 0 });

    const sent = exportTranscript.mock.calls[0][0];
    expect(sent.sessionId).toBe("abc");
    expect(sent.segments.map((s) => s.text)).toEqual([LONG, "second line"]);
    expect(sent.startedAt).toBe("2026-07-06T01:02:03.000Z");
  });

  it("passes the stored summary along", async () => {
    const name = storeSession(dir, "abc", Date.UTC(2026, 6, 6, 1, 2, 3));
    writeSummary(dir, name, "A chat happened.");
    const exportTranscript = ok();

    await backfillNotion({ dir, export: exportTranscript, delayMs: 0 });

    expect(exportTranscript.mock.calls[0][1]).toBe("A chat happened.");
  });

  it("skips transcripts that already have an export marker", async () => {
    const name = storeSession(dir, "abc", Date.UTC(2026, 6, 6, 1, 2, 3));
    writeExportMarker(dir, name, { pageId: "old", url: "u" });
    const exportTranscript = ok();

    const result = await backfillNotion({ dir, export: exportTranscript, delayMs: 0 });

    expect(exportTranscript).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it("skips near-empty transcripts", async () => {
    storeSession(dir, "abc", Date.UTC(2026, 6, 6, 1, 2, 3), ["hi"]);
    const exportTranscript = ok();

    const result = await backfillNotion({ dir, export: exportTranscript, delayMs: 0 });

    expect(exportTranscript).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it("keeps going after a failed export and reports it", async () => {
    storeSession(dir, "aaa", Date.UTC(2026, 6, 6, 1, 2, 3));
    storeSession(dir, "bbb", Date.UTC(2026, 6, 6, 2, 2, 3));
    let calls = 0;
    const exportTranscript = vi.fn(async () => {
      if (++calls === 1) throw new Error("notion down");
      return { pageId: "p2", url: "u2" };
    });

    const result = await backfillNotion({ dir, export: exportTranscript, delayMs: 0 });

    expect(exportTranscript).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ exported: 1, failed: 1 });
  });

  it("exports oldest first", async () => {
    storeSession(dir, "newer", Date.UTC(2026, 6, 6, 5, 0, 0));
    storeSession(dir, "older", Date.UTC(2026, 6, 6, 1, 0, 0));
    const exportTranscript = ok();

    await backfillNotion({ dir, export: exportTranscript, delayMs: 0 });

    const ids = exportTranscript.mock.calls.map((c) => c[0].sessionId);
    expect(ids).toEqual(["older", "newer"]);
  });

  it("stops after the requested limit", async () => {
    storeSession(dir, "aaa", Date.UTC(2026, 6, 6, 1, 0, 0));
    storeSession(dir, "bbb", Date.UTC(2026, 6, 6, 2, 0, 0));
    storeSession(dir, "ccc", Date.UTC(2026, 6, 6, 3, 0, 0));
    const exportTranscript = ok();

    const result = await backfillNotion({ dir, export: exportTranscript, delayMs: 0, limit: 2 });

    expect(exportTranscript).toHaveBeenCalledTimes(2);
    expect(result.exported).toBe(2);
  });

  it("does nothing when the transcript directory does not exist", async () => {
    const exportTranscript = ok();

    const result = await backfillNotion({
      dir: join(dir, "missing"),
      export: exportTranscript,
      delayMs: 0,
    });

    expect(exportTranscript).not.toHaveBeenCalled();
    expect(result.exported).toBe(0);
  });

  it("paces requests to stay under Notion's rate limit", async () => {
    storeSession(dir, "aaa", Date.UTC(2026, 6, 6, 1, 0, 0));
    storeSession(dir, "bbb", Date.UTC(2026, 6, 6, 2, 0, 0));
    const waits: number[] = [];

    await backfillNotion({
      dir,
      export: ok(),
      delayMs: 400,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    expect(waits).toEqual([400, 400]);
  });
});
