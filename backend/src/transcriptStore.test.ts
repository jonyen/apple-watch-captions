import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  TranscriptStore,
  FinalizedTranscript,
  listTranscripts,
  readTranscript,
  writeSummary,
  readExportMarker,
  writeExportMarker,
  deleteTranscript,
} from "./transcriptStore";

describe("TranscriptStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "transcripts-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const T0 = Date.UTC(2026, 6, 6, 1, 2, 3);

  it("appends final captions to one JSONL file per session", () => {
    let t = T0;
    const store = new TranscriptStore({ dir, now: () => (t += 1000) });
    store.append("abc-123", "hello");
    store.append("abc-123", "world");
    store.append("other", "different session");

    const files = readdirSync(dir).sort();
    expect(files).toHaveLength(2);
    const lines = readFileSync(join(dir, files[0]), "utf8").trim().split("\n");
    expect(lines.map((l) => JSON.parse(l).text)).toEqual(["hello", "world"]);
  });

  it("finalize hands collected segments to the hook exactly once", () => {
    const finalized: FinalizedTranscript[] = [];
    const store = new TranscriptStore({ dir, now: () => T0, onFinalize: (f) => finalized.push(f) });
    store.append("abc", "hello");
    store.finalize("abc");
    store.finalize("abc");
    expect(finalized).toHaveLength(1);
    expect(finalized[0].sessionId).toBe("abc");
    expect(finalized[0].segments.map((s) => s.text)).toEqual(["hello"]);
  });

  it("finalize of a session with no captions does nothing", () => {
    const finalized: FinalizedTranscript[] = [];
    const store = new TranscriptStore({ dir, now: () => T0, onFinalize: (f) => finalized.push(f) });
    store.finalize("never-spoke");
    expect(finalized).toHaveLength(0);
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it("lists stored transcripts with previews and reads them back", () => {
    const store = new TranscriptStore({ dir, now: () => T0 });
    store.append("abc", "hello");
    store.append("abc", "world");

    const list = listTranscripts(dir);
    expect(list).toHaveLength(1);
    expect(list[0].segmentCount).toBe(2);
    expect(list[0].preview).toBe("hello world");
    expect(list[0].hasSummary).toBe(false);

    const detail = readTranscript(dir, list[0].name);
    expect(detail?.segments.map((s) => s.text)).toEqual(["hello", "world"]);
    expect(detail?.summary).toBeNull();
  });

  it("round-trips a summary", () => {
    const store = new TranscriptStore({ dir, now: () => T0 });
    store.append("abc", "hello");
    const name = listTranscripts(dir)[0].name;
    writeSummary(dir, name, "A short chat.");
    expect(readTranscript(dir, name)?.summary).toBe("A short chat.");
    expect(listTranscripts(dir)[0].hasSummary).toBe(true);
  });

  it("appends into an existing transcript when a session is reopened", () => {
    const first = new TranscriptStore({ dir, now: () => T0 });
    first.append("abc", "first line");
    const name = listTranscripts(dir)[0].name;
    first.finalize("abc");

    // A later session resumes that transcript rather than starting a new one.
    const second = new TranscriptStore({ dir, now: () => T0 + 60_000 });
    second.reopen("xyz", name);
    second.append("xyz", "second line");

    expect(listTranscripts(dir)).toHaveLength(1);
    expect(readTranscript(dir, name)?.segments.map((s) => s.text)).toEqual([
      "first line",
      "second line",
    ]);
  });

  it("reports a reopened transcript as resumed, with the segments it already had", () => {
    const first = new TranscriptStore({ dir, now: () => T0 });
    first.append("abc", "first line");
    const name = listTranscripts(dir)[0].name;
    first.finalize("abc");

    let finalized: FinalizedTranscript | undefined;
    const second = new TranscriptStore({
      dir,
      now: () => T0 + 60_000,
      onFinalize: (t) => (finalized = t),
    });
    second.reopen("xyz", name);
    second.append("xyz", "second line");
    second.finalize("xyz");

    expect(finalized?.name).toBe(name);
    expect(finalized?.resumed).toBe(true);
    expect(finalized?.segments.map((s) => s.text)).toEqual(["first line", "second line"]);
  });

  it("keeps the original start time when resuming", () => {
    const first = new TranscriptStore({ dir, now: () => T0 });
    first.append("abc", "first line");
    const name = listTranscripts(dir)[0].name;
    const startedAt = readTranscript(dir, name)!.segments[0].at;
    first.finalize("abc");

    let finalized: FinalizedTranscript | undefined;
    const second = new TranscriptStore({
      dir,
      now: () => T0 + 60_000,
      onFinalize: (t) => (finalized = t),
    });
    second.reopen("xyz", name);
    second.append("xyz", "second line");
    second.finalize("xyz");

    expect(finalized?.startedAt).toBe(startedAt);
  });

  it("ignores a reopen for a transcript that does not exist", () => {
    const store = new TranscriptStore({ dir, now: () => T0 });
    store.reopen("xyz", "2026-01-01T00-00-00Z_nope");
    store.append("xyz", "hello");

    // Falls back to a normal new transcript rather than throwing.
    const listed = listTranscripts(dir);
    expect(listed).toHaveLength(1);
    expect(listed[0].name).not.toContain("nope");
  });

  it("rejects a hostile name on reopen", () => {
    const store = new TranscriptStore({ dir, now: () => T0 });
    store.reopen("xyz", "../../etc/passwd");
    store.append("xyz", "hello");

    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain("..");
  });

  it("records how much of a transcript has been exported", () => {
    const store = new TranscriptStore({ dir, now: () => T0 });
    store.append("abc", "hello");
    const name = listTranscripts(dir)[0].name;

    writeExportMarker(dir, name, { pageId: "p1", url: "u", exportedSegments: 1 });

    expect(readExportMarker(dir, name)).toMatchObject({ exportedSegments: 1 });
  });

  it("exposes the summary title in the listing", () => {
    const store = new TranscriptStore({ dir, now: () => T0 });
    store.append("abc", "hello");
    const name = listTranscripts(dir)[0].name;
    writeSummary(dir, name, "Title: A chat about roadmaps\n\nAn overview.");

    expect(listTranscripts(dir)[0].title).toBe("A chat about roadmaps");
  });

  it("leaves the listing title unset when a transcript has no summary", () => {
    const store = new TranscriptStore({ dir, now: () => T0 });
    store.append("abc", "hello");

    expect(listTranscripts(dir)[0].title).toBeUndefined();
  });

  it("rejects path-traversal names on read", () => {
    expect(readTranscript(dir, "../etc/passwd")).toBeNull();
  });

  it("round-trips an export marker", () => {
    const store = new TranscriptStore({ dir, now: () => T0 });
    store.append("abc", "hello");
    const name = listTranscripts(dir)[0].name;

    expect(readExportMarker(dir, name)).toBeNull();
    writeExportMarker(dir, name, { pageId: "page-1", url: "https://notion.so/page-1" });

    expect(readExportMarker(dir, name)).toMatchObject({
      pageId: "page-1",
      url: "https://notion.so/page-1",
    });
  });

  it("rejects path-traversal names on marker read", () => {
    expect(readExportMarker(dir, "../../secrets")).toBeNull();
  });

  it("treats an unreadable marker as not exported", () => {
    const store = new TranscriptStore({ dir, now: () => T0 });
    store.append("abc", "hello");
    const name = listTranscripts(dir)[0].name;
    writeFileSync(join(dir, `${name}.notion.json`), "{ truncated");

    expect(readExportMarker(dir, name)).toBeNull();
  });

  it("does not mistake a marker file for a transcript", () => {
    const store = new TranscriptStore({ dir, now: () => T0 });
    store.append("abc", "hello");
    const name = listTranscripts(dir)[0].name;
    writeExportMarker(dir, name, { pageId: "page-1", url: "u" });

    expect(listTranscripts(dir)).toHaveLength(1);
  });

  it("sanitizes hostile session ids in filenames", () => {
    const store = new TranscriptStore({ dir, now: () => T0 });
    store.append("../../evil", "hi");
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain("..");
  });

  it("persists channel tags on segments", () => {
    const store = new TranscriptStore({ dir, now: () => T0 });
    store.append("abc", "me talking", 0);
    store.append("abc", "video audio", 1);
    store.append("abc", "mono line");
    const detail = readTranscript(dir, listTranscripts(dir)[0].name);
    expect(detail?.segments.map((s) => s.channel)).toEqual([0, 1, undefined]);

    // Guard against regressions where a mono segment gets serialized with an
    // explicit `"channel": undefined`-shaped key (JSON.stringify would drop
    // it, but a stray default value would not) — inspect the raw JSONL line.
    const file = readdirSync(dir).find((f) => f.endsWith("_abc.jsonl"))!;
    const lines = readFileSync(join(dir, file), "utf8").trim().split("\n");
    expect(lines[2]).not.toContain('"channel"');
  });
});

describe("activeName", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "active-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reports the transcript a live session is writing to", () => {
    const store = new TranscriptStore({ dir, now: () => Date.UTC(2026, 6, 6, 1, 2, 3) });
    expect(store.activeName("abc")).toBeUndefined();

    store.append("abc", "hello");

    expect(store.activeName("abc")).toBe(listTranscripts(dir)[0].name);
  });

  it("forgets the name once the session is finalized", () => {
    const store = new TranscriptStore({ dir, now: () => Date.UTC(2026, 6, 6, 1, 2, 3) });
    store.append("abc", "hello");
    store.finalize("abc");

    expect(store.activeName("abc")).toBeUndefined();
  });
});

describe("deleteTranscript", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "delete-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const T0 = Date.UTC(2026, 6, 6, 1, 2, 3);

  /** A stored transcript with its summary and export marker alongside it. */
  function storeOne(): string {
    const store = new TranscriptStore({ dir, now: () => T0 });
    store.append("abc", "hello");
    const name = listTranscripts(dir)[0].name;
    writeSummary(dir, name, "Title: A chat\n\nAn overview.");
    writeExportMarker(dir, name, { pageId: "page-1", url: "https://notion.so/page-1" });
    return name;
  }

  it("removes the transcript, its summary, and its export marker", () => {
    const name = storeOne();

    expect(deleteTranscript(dir, name)).toBe(true);

    expect(readdirSync(dir)).toEqual([]);
    expect(listTranscripts(dir)).toEqual([]);
  });

  it("deletes a transcript that was never summarized or exported", () => {
    const store = new TranscriptStore({ dir, now: () => T0 });
    store.append("abc", "hello");
    const name = listTranscripts(dir)[0].name;

    expect(deleteTranscript(dir, name)).toBe(true);

    expect(readdirSync(dir)).toEqual([]);
  });

  it("reports false for a transcript that is not there", () => {
    expect(deleteTranscript(dir, "2026-07-06T01-02-03Z_missing")).toBe(false);
  });

  it("rejects path-traversal names without touching the filesystem", () => {
    const name = storeOne();

    expect(deleteTranscript(dir, "../../etc/passwd")).toBe(false);

    expect(listTranscripts(dir).map((t) => t.name)).toEqual([name]);
  });
});
