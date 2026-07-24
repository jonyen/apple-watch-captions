import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createFinalizer } from "./finalizer";
import {
  FinalizedTranscript,
  readTranscript,
  TranscriptStore,
  listTranscripts,
  readExportMarker,
} from "./transcriptStore";

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

  it("exports even when no summarizer is configured", async () => {
    const exportTranscript = vi.fn(
      async (_t: FinalizedTranscript, _summary: string | null) => ({ pageId: "p1", url: "u1" }),
    );

    createFinalizer({ dir, export: exportTranscript })(transcript(LONG));
    await settle();

    expect(exportTranscript).toHaveBeenCalledOnce();
    expect(exportTranscript.mock.calls[0][1]).toBeNull();
  });

  it("hands the generated summary to the exporter", async () => {
    const exportTranscript = vi.fn(
      async (_t: FinalizedTranscript, _summary: string | null) => ({ pageId: "p1", url: "u1" }),
    );

    createFinalizer({
      dir,
      summarize: async () => "A chat happened.",
      export: exportTranscript,
    })(transcript(LONG));
    await settle();

    expect(exportTranscript.mock.calls[0][1]).toBe("A chat happened.");
  });

  it("records the export so a later finalize does not duplicate the page", async () => {
    const exportTranscript = vi.fn(
      async (_t: FinalizedTranscript, _summary: string | null) => ({ pageId: "p1", url: "u1" }),
    );
    const finalize = createFinalizer({ dir, export: exportTranscript });

    finalize(transcript(LONG));
    await settle();
    expect(readExportMarker(dir, transcript(LONG).name)).toMatchObject({ pageId: "p1" });

    finalize(transcript(LONG));
    await settle();
    expect(exportTranscript).toHaveBeenCalledOnce();
  });

  it("leaves no marker when the export fails, so it can be retried", async () => {
    const exportTranscript = vi.fn(async () => {
      throw new Error("notion down");
    });
    const finalize = createFinalizer({ dir, export: exportTranscript });

    expect(() => finalize(transcript(LONG))).not.toThrow();
    await settle();

    expect(readExportMarker(dir, transcript(LONG).name)).toBeNull();
  });

  it("skips exporting near-empty transcripts", async () => {
    const exportTranscript = vi.fn(
      async (_t: FinalizedTranscript, _summary: string | null) => ({ pageId: "p1", url: "u1" }),
    );

    createFinalizer({ dir, export: exportTranscript })(transcript(["hi"]));
    await settle();

    expect(exportTranscript).not.toHaveBeenCalled();
  });

  it("still stores the summary when the export fails", async () => {
    const store = new TranscriptStore({ dir, now: () => Date.UTC(2026, 6, 6, 1, 2, 3) });
    store.append("abc", LONG[0]);
    const name = listTranscripts(dir)[0].name;

    createFinalizer({
      dir,
      summarize: async () => "A chat happened.",
      export: async () => {
        throw new Error("notion down");
      },
    })({ ...transcript(LONG), name });
    await settle();

    expect(readTranscript(dir, name)?.summary).toBe("A chat happened.");
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
});
