import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { backfillNotion } from "./notionBackfill";
import { ResolveExporters, UserExporters } from "./finalizer";
import {
  TranscriptStore,
  FinalizedTranscript,
  listTranscripts,
  readExportMarker,
  writeExportMarker,
  writeSummary,
  userDir,
} from "./transcriptStore";

const LONG = "this is a reasonably long caption about something in particular";
/**
 * A single fixed user. `backfillNotion` still sweeps one directory handed to
 * it by its caller (Task 12 moves callers onto per-user directories); these
 * tests exercise it against `userDir(root, U)`, standing in for whatever
 * directory it is eventually pointed at.
 */
const U = "user-1";
const scoped = (root: string) => userDir(root, U);

/** Write a finished transcript to disk the way a real session would. */
function storeSession(root: string, id: string, at: number, texts: string[] = [LONG]): string {
  const store = new TranscriptStore({ root, now: () => at });
  for (const text of texts) store.append(U, id, text);
  return listTranscripts(scoped(root)).find((t) => t.name.endsWith(`_${id}`))!.name;
}

const ok = () => vi.fn(async (_t: FinalizedTranscript, _s: string | null) => ({
  pageId: "p1",
  url: "https://notion.so/p1",
}));

/** Wraps an `export` fn into the `resolve` shape `backfillNotion` now takes, for user `U`. */
function resolveWith(exportTranscript: UserExporters["export"]): ResolveExporters {
  return (userId) =>
    userId === U
      ? {
          export: exportTranscript,
          update: async () => ({ pageId: "p1", url: "https://notion.so/p1", exportedSegments: 0 }),
          patchSummary: async () => {},
        }
      : undefined;
}

/** A user with no Notion connection at all. */
const noConnection: ResolveExporters = () => undefined;

describe("backfillNotion", () => {
  let root: string;
  let consoleError: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "backfill-"));
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("exports stored transcripts that were never exported", async () => {
    const name = storeSession(root, "abc", Date.UTC(2026, 6, 6, 1, 2, 3));
    const exportTranscript = ok();

    const result = await backfillNotion({
      dir: scoped(root),
      userId: U,
      resolve: resolveWith(exportTranscript),
      delayMs: 0,
    });

    expect(exportTranscript).toHaveBeenCalledOnce();
    expect(result.exported).toBe(1);
    expect(readExportMarker(scoped(root), name)).toMatchObject({ pageId: "p1" });
  });

  it("reconstructs the transcript's segments and session id", async () => {
    storeSession(root, "abc", Date.UTC(2026, 6, 6, 1, 2, 3), [LONG, "second line"]);
    const exportTranscript = ok();

    await backfillNotion({
      dir: scoped(root),
      userId: U,
      resolve: resolveWith(exportTranscript),
      delayMs: 0,
    });

    const sent = exportTranscript.mock.calls[0][0];
    expect(sent.sessionId).toBe("abc");
    expect(sent.segments.map((s) => s.text)).toEqual([LONG, "second line"]);
    expect(sent.startedAt).toBe("2026-07-06T01:02:03.000Z");
    // The sweep runs per user directory, so it knows the owner. Rebuilding
    // without one leaves `userId` empty — harmless while nothing downstream
    // reads it, and a trap for the per-user export work that will.
    expect(sent.userId).toBe(U);
  });

  it("passes the stored summary along", async () => {
    const name = storeSession(root, "abc", Date.UTC(2026, 6, 6, 1, 2, 3));
    writeSummary(scoped(root), name, "A chat happened.");
    const exportTranscript = ok();

    await backfillNotion({
      dir: scoped(root),
      userId: U,
      resolve: resolveWith(exportTranscript),
      delayMs: 0,
    });

    expect(exportTranscript.mock.calls[0][1]).toBe("A chat happened.");
  });

  it("skips transcripts that already have an export marker", async () => {
    const name = storeSession(root, "abc", Date.UTC(2026, 6, 6, 1, 2, 3));
    writeExportMarker(scoped(root), name, { pageId: "old", url: "u" });
    const exportTranscript = ok();

    const result = await backfillNotion({
      dir: scoped(root),
      userId: U,
      resolve: resolveWith(exportTranscript),
      delayMs: 0,
    });

    expect(exportTranscript).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it("skips near-empty transcripts", async () => {
    storeSession(root, "abc", Date.UTC(2026, 6, 6, 1, 2, 3), ["hi"]);
    const exportTranscript = ok();

    const result = await backfillNotion({
      dir: scoped(root),
      userId: U,
      resolve: resolveWith(exportTranscript),
      delayMs: 0,
    });

    expect(exportTranscript).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it("keeps going after a failed export and reports it", async () => {
    storeSession(root, "aaa", Date.UTC(2026, 6, 6, 1, 2, 3));
    storeSession(root, "bbb", Date.UTC(2026, 6, 6, 2, 2, 3));
    let calls = 0;
    const exportTranscript = vi.fn(async () => {
      if (++calls === 1) throw new Error("notion down");
      return { pageId: "p2", url: "u2" };
    });

    const result = await backfillNotion({
      dir: scoped(root),
      userId: U,
      resolve: resolveWith(exportTranscript),
      delayMs: 0,
    });

    expect(exportTranscript).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ exported: 1, failed: 1 });
  });

  it("exports oldest first", async () => {
    storeSession(root, "newer", Date.UTC(2026, 6, 6, 5, 0, 0));
    storeSession(root, "older", Date.UTC(2026, 6, 6, 1, 0, 0));
    const exportTranscript = ok();

    await backfillNotion({
      dir: scoped(root),
      userId: U,
      resolve: resolveWith(exportTranscript),
      delayMs: 0,
    });

    const ids = exportTranscript.mock.calls.map((c) => c[0].sessionId);
    expect(ids).toEqual(["older", "newer"]);
  });

  it("stops after the requested limit", async () => {
    storeSession(root, "aaa", Date.UTC(2026, 6, 6, 1, 0, 0));
    storeSession(root, "bbb", Date.UTC(2026, 6, 6, 2, 0, 0));
    storeSession(root, "ccc", Date.UTC(2026, 6, 6, 3, 0, 0));
    const exportTranscript = ok();

    const result = await backfillNotion({
      dir: scoped(root),
      userId: U,
      resolve: resolveWith(exportTranscript),
      delayMs: 0,
      limit: 2,
    });

    expect(exportTranscript).toHaveBeenCalledTimes(2);
    expect(result.exported).toBe(2);
  });

  it("does nothing when the transcript directory does not exist", async () => {
    const exportTranscript = ok();

    const result = await backfillNotion({
      dir: join(scoped(root), "missing"),
      userId: U,
      resolve: resolveWith(exportTranscript),
      delayMs: 0,
    });

    expect(exportTranscript).not.toHaveBeenCalled();
    expect(result.exported).toBe(0);
  });

  it("paces requests to stay under Notion's rate limit", async () => {
    storeSession(root, "aaa", Date.UTC(2026, 6, 6, 1, 0, 0));
    storeSession(root, "bbb", Date.UTC(2026, 6, 6, 2, 0, 0));
    const waits: number[] = [];

    await backfillNotion({
      dir: scoped(root),
      userId: U,
      resolve: resolveWith(ok()),
      delayMs: 400,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    expect(waits).toEqual([400, 400]);
  });

  it("does nothing for a user with no Notion connection", async () => {
    storeSession(root, "abc", Date.UTC(2026, 6, 6, 1, 2, 3));

    const result = await backfillNotion({
      dir: scoped(root),
      userId: U,
      resolve: noConnection,
      delayMs: 0,
    });

    expect(result).toEqual({ exported: 0, skipped: 0, failed: 0 });
  });

  it("does not let one user's throwing resolve stop the sweep for the next user in the loop", async () => {
    // Mirrors what `runBackfills` in index.ts does: call `backfillNotion`
    // once per user directory, in a loop, sharing one `resolve`. A sealed
    // secret that fails to open for one user (rotated key, restored
    // database) must not abort export catch-up for the users after them.
    const bad = "user-bad";
    const good = "user-good";
    const store = new TranscriptStore({ root, now: () => Date.UTC(2026, 6, 6, 1, 2, 3) });
    store.append(bad, "s1", LONG);
    store.append(good, "s2", LONG);
    const goodName = listTranscripts(userDir(root, good))[0].name;

    const exportTranscript = ok();
    const resolve: ResolveExporters = (userId) => {
      if (userId === bad) throw new Error("bad auth tag");
      if (userId === good) {
        return {
          export: exportTranscript,
          update: async () => ({ pageId: "p1", url: "https://notion.so/p1", exportedSegments: 0 }),
          patchSummary: async () => {},
        };
      }
      return undefined;
    };

    const results = [];
    for (const userId of [bad, good]) {
      results.push(await backfillNotion({ dir: userDir(root, userId), userId, resolve, delayMs: 0 }));
    }

    expect(results[0]).toEqual({ exported: 0, skipped: 0, failed: 0 });
    expect(exportTranscript).toHaveBeenCalledOnce();
    expect(results[1].exported).toBe(1);
    expect(readExportMarker(userDir(root, good), goodName)).toMatchObject({ pageId: "p1" });
  });

  it("does not resolve the failing user's error into an unrecoverable state, and reports it", async () => {
    storeSession(root, "abc", Date.UTC(2026, 6, 6, 1, 2, 3));
    const resolve: ResolveExporters = () => {
      throw new Error("bad auth tag");
    };

    const result = await backfillNotion({ dir: scoped(root), userId: U, resolve, delayMs: 0 });

    expect(result).toEqual({ exported: 0, skipped: 0, failed: 0 });
  });

  // `backfillNotion` checks for a marker itself before ever calling
  // `exportOnce` (`readExportMarker` above, in the loop) — but `exportOnce`
  // re-reads the marker on its own (`finalizer.ts`). These are two separate
  // reads with a real window between them: `runBackfills` runs at boot while
  // the live finalizer path may already be landing markers for the same
  // transcript concurrently. `backfillNotion` never passes an updater, so
  // `exportOnce`'s `if (!update) return false` must fire quietly here.
  //
  // The exporter-not-called / marker-unchanged assertions below hold
  // identically whether that branch exists or not: without it,
  // `update(t, summary, marker)` calls `undefined` as a function, throws
  // synchronously, is caught by the catch two lines down, and returns a
  // failure — same externally observable result, except it logs "page
  // update failed for ...". That log line is one of the two things that
  // discriminate the two implementations, and it matters on its own: this
  // path is the boot sweep racing a live finalize, which is expected and
  // benign, not an export failure — logging one would mislead an operator
  // grepping for real problems. So `consoleError` staying silent is part of
  // what proves this test covers the branch it is named for.
  //
  // The other is the count. The final review's smaller item 4: silencing the
  // log left this case still counted as `failed`, so the boot log said
  // "Notion backfill: 0 exported, 1 failed" for a routine race — the
  // misleading signal moved one line down rather than going away. It is
  // `skipped` now, which is what "there was nothing to do here" already
  // means everywhere else in this sweep.
  it("leaves a marker written between listing and export alone, rather than re-exporting or overwriting it", async () => {
    const name = storeSession(root, "abc", Date.UTC(2026, 6, 6, 1, 2, 3));
    const exportTranscript = ok();

    const result = await backfillNotion({
      dir: scoped(root),
      userId: U,
      resolve: resolveWith(exportTranscript),
      delayMs: 1,
      // Stands in for the live finalizer path landing this transcript's
      // export in the window between the loop's own marker check (above,
      // already passed by the time this runs) and `exportOnce`'s own read.
      sleep: async () => {
        writeExportMarker(scoped(root), name, { pageId: "live-export", url: "https://notion.so/live" });
      },
    });

    expect(exportTranscript).not.toHaveBeenCalled();
    expect(result).toEqual({ exported: 0, skipped: 1, failed: 0 });
    expect(readExportMarker(scoped(root), name)).toMatchObject({ pageId: "live-export" });
    expect(consoleError).not.toHaveBeenCalled();
  });
});
