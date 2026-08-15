import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createFinalizer, ResolveExporters, UserExporters } from "./finalizer";
import {
  FinalizedTranscript,
  readTranscript,
  TranscriptStore,
  listTranscripts,
  readExportMarker,
  userDir,
} from "./transcriptStore";

const U = "user-1";

function transcript(texts: string[]): FinalizedTranscript {
  return {
    name: "2026-07-06T01-02-03Z_abc",
    userId: U,
    sessionId: "abc",
    startedAt: "2026-07-06T01:02:03Z",
    endedAt: "2026-07-06T01:05:03Z",
    segments: texts.map((text, i) => ({ at: `2026-07-06T01:02:0${i}Z`, text })),
  };
}

function transcriptFor(userId: string): FinalizedTranscript {
  return {
    name: "2026-01-01T00-00-00Z_s1",
    userId,
    sessionId: "s1",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:01:00.000Z",
    segments: [{ at: "2026-01-01T00:00:30.000Z", text: "a".repeat(80) }],
  };
}

/**
 * Wraps a bare `export`/`update` pair from a test into the `resolve` shape
 * `createFinalizer` now takes, standing in for one user's Notion connection.
 * Scoped to `U`, the fixed user most tests in this file use.
 */
function resolveWith(
  exportTranscript: UserExporters["export"],
  update?: UserExporters["update"],
): ResolveExporters {
  return (userId) =>
    userId === U
      ? {
          export: exportTranscript,
          update: update ?? (async () => ({ pageId: "p1", url: "u1", exportedSegments: 0 })),
          patchSummary: async () => {},
        }
      : undefined;
}

const LONG = ["this is a reasonably long caption about something", "and another one"];
const settle = () => new Promise((r) => setTimeout(r, 20));
/** `createFinalizer` fires and forgets; let its microtasks drain. */
const flush = settle;

describe("createFinalizer", () => {
  let root: string;
  let dir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "finalizer-"));
    dir = userDir(root, U);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("exports through the transcript owner's own Notion connection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wc-"));
    const seen: string[] = [];
    const resolve = (userId: string) =>
      userId === "alice"
        ? {
            export: async () => {
              seen.push("alice-export");
              return { pageId: "p1", url: "https://notion/p1" };
            },
            update: async () => ({ pageId: "p1", url: "https://notion/p1", exportedSegments: 1 }),
            patchSummary: async () => {},
          }
        : undefined;

    const finalize = createFinalizer({ root: dir, resolve });
    finalize(transcriptFor("alice"));
    await flush();
    expect(seen).toEqual(["alice-export"]);
  });

  it("does not export for a user with no connection", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wc-"));
    const seen: string[] = [];
    const resolve = (userId: string) =>
      userId === "alice"
        ? {
            export: async () => {
              seen.push("alice-export");
              return { pageId: "p1", url: "https://notion/p1" };
            },
            update: async () => ({ pageId: "p1", url: "https://notion/p1", exportedSegments: 1 }),
            patchSummary: async () => {},
          }
        : undefined;

    const finalize = createFinalizer({ root: dir, resolve });
    finalize(transcriptFor("mallory"));
    await flush();
    expect(seen).toEqual([]);
  });

  it("stores the summary next to the transcript", async () => {
    const store = new TranscriptStore({ root, now: () => Date.UTC(2026, 6, 6, 1, 2, 3) });
    store.append(U, "abc", LONG[0]);
    const name = listTranscripts(dir)[0].name;

    const finalize = createFinalizer({ root, summarize: async () => "A chat happened." });
    finalize({ ...transcript(LONG), name });
    await settle();

    expect(readTranscript(dir, name)?.summary).toBe("A chat happened.");
  });

  it("skips near-empty transcripts", async () => {
    const summarize = vi.fn(async () => "s");
    createFinalizer({ root, summarize })(transcript(["hi"]));
    await settle();
    expect(summarize).not.toHaveBeenCalled();
  });

  it("exports even when no summarizer is configured", async () => {
    const exportTranscript = vi.fn(
      async (_t: FinalizedTranscript, _summary: string | null) => ({ pageId: "p1", url: "u1" }),
    );

    createFinalizer({ root, resolve: resolveWith(exportTranscript) })(transcript(LONG));
    await settle();

    expect(exportTranscript).toHaveBeenCalledOnce();
    expect(exportTranscript.mock.calls[0][1]).toBeNull();
  });

  it("hands the generated summary to the exporter", async () => {
    const exportTranscript = vi.fn(
      async (_t: FinalizedTranscript, _summary: string | null) => ({ pageId: "p1", url: "u1" }),
    );

    createFinalizer({
      root,
      summarize: async () => "A chat happened.",
      resolve: resolveWith(exportTranscript),
    })(transcript(LONG));
    await settle();

    expect(exportTranscript.mock.calls[0][1]).toBe("A chat happened.");
  });

  it("records the export so a later finalize does not duplicate the page", async () => {
    const exportTranscript = vi.fn(
      async (_t: FinalizedTranscript, _summary: string | null) => ({ pageId: "p1", url: "u1" }),
    );
    const finalize = createFinalizer({ root, resolve: resolveWith(exportTranscript) });

    finalize(transcript(LONG));
    await settle();
    expect(readExportMarker(dir, transcript(LONG).name)).toMatchObject({ pageId: "p1" });

    finalize(transcript(LONG));
    await settle();
    expect(exportTranscript).toHaveBeenCalledOnce();
  });

  it("records how much of the transcript reached the page on first export", async () => {
    const exportTranscript = vi.fn(
      async (_t: FinalizedTranscript, _summary: string | null) => ({ pageId: "p1", url: "u1" }),
    );

    createFinalizer({ root, resolve: resolveWith(exportTranscript) })(transcript(LONG));
    await settle();

    expect(readExportMarker(dir, transcript(LONG).name)).toMatchObject({
      pageId: "p1",
      exportedSegments: 2,
    });
  });

  it("updates the existing page when a resumed session ends", async () => {
    const exportTranscript = vi.fn(
      async (_t: FinalizedTranscript, _summary: string | null) => ({ pageId: "p1", url: "u1" }),
    );
    const update = vi.fn(async () => ({ pageId: "p1", url: "u1", exportedSegments: 5 }));
    const finalize = createFinalizer({ root, resolve: resolveWith(exportTranscript, update) });

    finalize(transcript(LONG));
    await settle();
    finalize({ ...transcript(LONG), resumed: true });
    await settle();

    expect(exportTranscript).toHaveBeenCalledOnce(); // not re-created
    expect(update).toHaveBeenCalledOnce();
    expect(readExportMarker(dir, transcript(LONG).name)).toMatchObject({ exportedSegments: 5 });
  });

  // Previously exercised via a `FinalizerOptions` with `export` but no
  // `update`, independently configurable. `resolve` now hands back both (and
  // `patchSummary`) together as one `UserExporters` bundle built from a
  // single Notion connection, so "export configured, update not" is no
  // longer a reachable state through the public API — this scenario is
  // retired rather than ported.

  it("keeps the old marker when updating the page fails, so it retries", async () => {
    const exportTranscript = vi.fn(
      async (_t: FinalizedTranscript, _summary: string | null) => ({ pageId: "p1", url: "u1" }),
    );
    const update = vi.fn(async () => {
      throw new Error("notion down");
    });
    const finalize = createFinalizer({ root, resolve: resolveWith(exportTranscript, update) });

    finalize(transcript(LONG));
    await settle();
    finalize({ ...transcript(LONG), resumed: true });
    await settle();

    expect(readExportMarker(dir, transcript(LONG).name)).toMatchObject({ exportedSegments: 2 });
  });

  it("leaves no marker when the export fails, so it can be retried", async () => {
    const exportTranscript = vi.fn(async () => {
      throw new Error("notion down");
    });
    const finalize = createFinalizer({ root, resolve: resolveWith(exportTranscript) });

    expect(() => finalize(transcript(LONG))).not.toThrow();
    await settle();

    expect(readExportMarker(dir, transcript(LONG).name)).toBeNull();
  });

  it("skips exporting near-empty transcripts", async () => {
    const exportTranscript = vi.fn(
      async (_t: FinalizedTranscript, _summary: string | null) => ({ pageId: "p1", url: "u1" }),
    );

    createFinalizer({ root, resolve: resolveWith(exportTranscript) })(transcript(["hi"]));
    await settle();

    expect(exportTranscript).not.toHaveBeenCalled();
  });

  it("still stores the summary when the export fails", async () => {
    const store = new TranscriptStore({ root, now: () => Date.UTC(2026, 6, 6, 1, 2, 3) });
    store.append(U, "abc", LONG[0]);
    const name = listTranscripts(dir)[0].name;

    createFinalizer({
      root,
      summarize: async () => "A chat happened.",
      resolve: resolveWith(async () => {
        throw new Error("notion down");
      }),
    })({ ...transcript(LONG), name });
    await settle();

    expect(readTranscript(dir, name)?.summary).toBe("A chat happened.");
  });

  it("survives a failing summarizer", async () => {
    const finalize = createFinalizer({
      root,
      summarize: async () => {
        throw new Error("api down");
      },
    });
    expect(() => finalize(transcript(LONG))).not.toThrow();
    await settle();
  });

  // `createFinalizer` invokes `run` fire-and-forget (`void run(opts, t)`), so
  // a throw inside it becomes an unhandled promise rejection — which by
  // default kills the whole process — rather than a caught error. A
  // transcript with an unresolvable `userId` (here: the "" that
  // `rebuildFinalized` defaults to) is exactly what would trigger that, since
  // `userDir` throws for it.
  it("does not produce an unhandled rejection when the directory cannot be resolved", async () => {
    const rejections: unknown[] = [];
    const onRejection = (err: unknown) => rejections.push(err);
    process.on("unhandledRejection", onRejection);
    try {
      const finalize = createFinalizer({
        root,
        resolve: resolveWith(async () => ({ pageId: "p1", url: "u1" })),
      });
      expect(() => finalize({ ...transcript(LONG), userId: "" })).not.toThrow();
      await settle();
    } finally {
      process.off("unhandledRejection", onRejection);
    }
    expect(rejections).toEqual([]);
  });

  // Sibling of the test above, for the other thing `run` does before it ever
  // touches the filesystem: `resolve` reaches `ExportDestinationStore` in
  // production, which can throw (a sealed secret that fails to open — a
  // rotated key, a database restored from another environment — a
  // JSON.parse failure, a SQLite error). A throw here must not become an
  // unhandled rejection either, since it would take the whole process down
  // for every user on the very next finalize, not just this one.
  it("does not produce an unhandled rejection when resolve throws", async () => {
    const rejections: unknown[] = [];
    const onRejection = (err: unknown) => rejections.push(err);
    process.on("unhandledRejection", onRejection);
    try {
      const finalize = createFinalizer({
        root,
        resolve: () => {
          throw new Error("bad auth tag");
        },
      });
      expect(() => finalize(transcript(LONG))).not.toThrow();
      await settle();
    } finally {
      process.off("unhandledRejection", onRejection);
    }
    expect(rejections).toEqual([]);
  });

  it("still stores the summary when resolve throws", async () => {
    const store = new TranscriptStore({ root, now: () => Date.UTC(2026, 6, 6, 1, 2, 3) });
    store.append(U, "abc", LONG[0]);
    const name = listTranscripts(dir)[0].name;

    createFinalizer({
      root,
      summarize: async () => "A chat happened.",
      resolve: () => {
        throw new Error("bad auth tag");
      },
    })({ ...transcript(LONG), name });
    await settle();

    expect(readTranscript(dir, name)?.summary).toBe("A chat happened.");
  });
});
