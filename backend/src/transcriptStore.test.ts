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
  userDir,
} from "./transcriptStore";

describe("TranscriptStore", () => {
  let root: string;
  const U = "user-1";
  let dir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "transcripts-"));
    dir = userDir(root, U);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const T0 = Date.UTC(2026, 6, 6, 1, 2, 3);

  it("appends final captions to one JSONL file per session", () => {
    let t = T0;
    const store = new TranscriptStore({ root, now: () => (t += 1000) });
    store.append(U, "abc-123", "hello");
    store.append(U, "abc-123", "world");
    store.append(U, "other", "different session");

    const files = readdirSync(dir).sort();
    expect(files).toHaveLength(2);
    const lines = readFileSync(join(dir, files[0]), "utf8").trim().split("\n");
    expect(lines.map((l) => JSON.parse(l).text)).toEqual(["hello", "world"]);
  });

  it("finalize hands collected segments to the hook exactly once", () => {
    const finalized: FinalizedTranscript[] = [];
    const store = new TranscriptStore({ root, now: () => T0, onFinalize: (f) => finalized.push(f) });
    store.append(U, "abc", "hello");
    store.finalize(U, "abc");
    store.finalize(U, "abc");
    expect(finalized).toHaveLength(1);
    expect(finalized[0].sessionId).toBe("abc");
    expect(finalized[0].segments.map((s) => s.text)).toEqual(["hello"]);
  });

  it("finalize of a session with no captions does nothing", () => {
    const finalized: FinalizedTranscript[] = [];
    const store = new TranscriptStore({ root, now: () => T0, onFinalize: (f) => finalized.push(f) });
    store.finalize(U, "never-spoke");
    expect(finalized).toHaveLength(0);
    expect(readdirSync(root)).toHaveLength(0);
  });

  it("lists stored transcripts with previews and reads them back", () => {
    const store = new TranscriptStore({ root, now: () => T0 });
    store.append(U, "abc", "hello");
    store.append(U, "abc", "world");

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
    const store = new TranscriptStore({ root, now: () => T0 });
    store.append(U, "abc", "hello");
    const name = listTranscripts(dir)[0].name;
    writeSummary(dir, name, "A short chat.");
    expect(readTranscript(dir, name)?.summary).toBe("A short chat.");
    expect(listTranscripts(dir)[0].hasSummary).toBe(true);
  });

  it("appends into an existing transcript when a session is reopened", () => {
    const first = new TranscriptStore({ root, now: () => T0 });
    first.append(U, "abc", "first line");
    const name = listTranscripts(dir)[0].name;
    first.finalize(U, "abc");

    // A later session resumes that transcript rather than starting a new one.
    const second = new TranscriptStore({ root, now: () => T0 + 60_000 });
    second.reopen(U, "xyz", name);
    second.append(U, "xyz", "second line");

    expect(listTranscripts(dir)).toHaveLength(1);
    expect(readTranscript(dir, name)?.segments.map((s) => s.text)).toEqual([
      "first line",
      "second line",
    ]);
  });

  it("reports a reopened transcript as resumed, with the segments it already had", () => {
    const first = new TranscriptStore({ root, now: () => T0 });
    first.append(U, "abc", "first line");
    const name = listTranscripts(dir)[0].name;
    first.finalize(U, "abc");

    let finalized: FinalizedTranscript | undefined;
    const second = new TranscriptStore({
      root,
      now: () => T0 + 60_000,
      onFinalize: (t) => (finalized = t),
    });
    second.reopen(U, "xyz", name);
    second.append(U, "xyz", "second line");
    second.finalize(U, "xyz");

    expect(finalized?.name).toBe(name);
    expect(finalized?.resumed).toBe(true);
    expect(finalized?.segments.map((s) => s.text)).toEqual(["first line", "second line"]);
  });

  it("keeps the original start time when resuming", () => {
    const first = new TranscriptStore({ root, now: () => T0 });
    first.append(U, "abc", "first line");
    const name = listTranscripts(dir)[0].name;
    const startedAt = readTranscript(dir, name)!.segments[0].at;
    first.finalize(U, "abc");

    let finalized: FinalizedTranscript | undefined;
    const second = new TranscriptStore({
      root,
      now: () => T0 + 60_000,
      onFinalize: (t) => (finalized = t),
    });
    second.reopen(U, "xyz", name);
    second.append(U, "xyz", "second line");
    second.finalize(U, "xyz");

    expect(finalized?.startedAt).toBe(startedAt);
  });

  it("ignores a reopen for a transcript that does not exist", () => {
    const store = new TranscriptStore({ root, now: () => T0 });
    store.reopen(U, "xyz", "2026-01-01T00-00-00Z_nope");
    store.append(U, "xyz", "hello");

    // Falls back to a normal new transcript rather than throwing.
    const listed = listTranscripts(dir);
    expect(listed).toHaveLength(1);
    expect(listed[0].name).not.toContain("nope");
  });

  it("rejects a hostile name on reopen", () => {
    const store = new TranscriptStore({ root, now: () => T0 });
    store.reopen(U, "xyz", "../../etc/passwd");
    store.append(U, "xyz", "hello");

    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain("..");
  });

  it("records how much of a transcript has been exported", () => {
    const store = new TranscriptStore({ root, now: () => T0 });
    store.append(U, "abc", "hello");
    const name = listTranscripts(dir)[0].name;

    writeExportMarker(dir, name, { pageId: "p1", url: "u", exportedSegments: 1 });

    expect(readExportMarker(dir, name)).toMatchObject({ exportedSegments: 1 });
  });

  it("exposes the summary title in the listing", () => {
    const store = new TranscriptStore({ root, now: () => T0 });
    store.append(U, "abc", "hello");
    const name = listTranscripts(dir)[0].name;
    writeSummary(dir, name, "Title: A chat about roadmaps\n\nAn overview.");

    expect(listTranscripts(dir)[0].title).toBe("A chat about roadmaps");
  });

  it("leaves the listing title unset when a transcript has no summary", () => {
    const store = new TranscriptStore({ root, now: () => T0 });
    store.append(U, "abc", "hello");

    expect(listTranscripts(dir)[0].title).toBeUndefined();
  });

  it("rejects path-traversal names on read", () => {
    expect(readTranscript(dir, "../etc/passwd")).toBeNull();
  });

  it("round-trips an export marker", () => {
    const store = new TranscriptStore({ root, now: () => T0 });
    store.append(U, "abc", "hello");
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
    const store = new TranscriptStore({ root, now: () => T0 });
    store.append(U, "abc", "hello");
    const name = listTranscripts(dir)[0].name;
    writeFileSync(join(dir, `${name}.notion.json`), "{ truncated");

    expect(readExportMarker(dir, name)).toBeNull();
  });

  it("does not mistake a marker file for a transcript", () => {
    const store = new TranscriptStore({ root, now: () => T0 });
    store.append(U, "abc", "hello");
    const name = listTranscripts(dir)[0].name;
    writeExportMarker(dir, name, { pageId: "page-1", url: "u" });

    expect(listTranscripts(dir)).toHaveLength(1);
  });

  it("sanitizes hostile session ids in filenames", () => {
    const store = new TranscriptStore({ root, now: () => T0 });
    store.append(U, "../../evil", "hi");
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain("..");
  });

  it("persists channel tags on segments", () => {
    const store = new TranscriptStore({ root, now: () => T0 });
    store.append(U, "abc", "me talking", 0);
    store.append(U, "abc", "video audio", 1);
    store.append(U, "abc", "mono line");
    const detail = readTranscript(dir, listTranscripts(dir)[0].name);
    expect(detail?.segments.map((s) => s.channel)).toEqual([0, 1, undefined]);

    // Guard against regressions where a mono segment gets serialized with an
    // explicit `"channel": undefined`-shaped key (JSON.stringify would drop
    // it, but a stray default value would not) — inspect the raw JSONL line.
    const file = readdirSync(dir).find((f) => f.endsWith("_abc.jsonl"))!;
    const lines = readFileSync(join(dir, file), "utf8").trim().split("\n");
    expect(lines[2]).not.toContain('"channel"');
  });

  it("writes each user's transcripts to their own directory", () => {
    const root = mkdtempSync(join(tmpdir(), "wc-"));
    const store = new TranscriptStore({ root });
    store.append("user-a", "s1", "hello from a");
    store.append("user-b", "s1", "hello from b");
    expect(listTranscripts(userDir(root, "user-a"))).toHaveLength(1);
    expect(listTranscripts(userDir(root, "user-b"))).toHaveLength(1);
    expect(listTranscripts(userDir(root, "user-a"))[0].preview).toBe("hello from a");
  });

  it("does not reopen another user's transcript", () => {
    const root = mkdtempSync(join(tmpdir(), "wc-"));
    const store = new TranscriptStore({ root });
    store.append("user-a", "s1", "private");
    const name = store.activeName("user-a", "s1")!;
    store.finalize("user-a", "s1");

    store.reopen("user-b", "s2", name);
    store.append("user-b", "s2", "intruder");
    expect(readTranscript(userDir(root, "user-a"), name)!.segments).toHaveLength(1);
  });

  it("carries the owner on the finalized transcript", () => {
    const root = mkdtempSync(join(tmpdir(), "wc-"));
    const seen: FinalizedTranscript[] = [];
    const store = new TranscriptStore({ root, onFinalize: (t) => seen.push(t) });
    store.append("user-a", "s1", "hello");
    store.finalize("user-a", "s1");
    expect(seen[0].userId).toBe("user-a");
  });
});

describe("userDir", () => {
  const root = "/tmp/wc-root-example";

  it("joins the root and userId for a normal id", () => {
    expect(userDir(root, "abc-123")).toBe(join(root, "abc-123"));
  });

  it("rejects a userId that could escape the root", () => {
    expect(() => userDir(root, "..")).toThrow();
    expect(() => userDir(root, "../../etc")).toThrow();
    expect(() => userDir(root, "foo/../../bar")).toThrow();
    expect(() => userDir(root, "a/b")).toThrow();
    expect(() => userDir(root, "a\\b")).toThrow();
    expect(() => userDir(root, "a\0b")).toThrow();
    expect(() => userDir(root, "")).toThrow();
    // A denylist of ".." + separators + null bytes still lets a bare "."
    // through, which `join(root, ".")` resolves to `root` itself — mapping
    // this user onto the shared legacy directory rather than escaping it,
    // but breaking the one-directory-per-user invariant all the same.
    expect(() => userDir(root, ".")).toThrow();
  });
});

describe("activeName", () => {
  let root: string;
  const U = "user-1";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "active-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reports the transcript a live session is writing to", () => {
    const store = new TranscriptStore({ root, now: () => Date.UTC(2026, 6, 6, 1, 2, 3) });
    expect(store.activeName(U, "abc")).toBeUndefined();

    store.append(U, "abc", "hello");

    expect(store.activeName(U, "abc")).toBe(listTranscripts(userDir(root, U))[0].name);
  });

  it("forgets the name once the session is finalized", () => {
    const store = new TranscriptStore({ root, now: () => Date.UTC(2026, 6, 6, 1, 2, 3) });
    store.append(U, "abc", "hello");
    store.finalize(U, "abc");

    expect(store.activeName(U, "abc")).toBeUndefined();
  });
});

describe("deleteTranscript", () => {
  let root: string;
  let dir: string;
  const U = "user-1";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "delete-"));
    dir = userDir(root, U);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const T0 = Date.UTC(2026, 6, 6, 1, 2, 3);

  /** A stored transcript with its summary and export marker alongside it. */
  function storeOne(): string {
    const store = new TranscriptStore({ root, now: () => T0 });
    store.append(U, "abc", "hello");
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
    const store = new TranscriptStore({ root, now: () => T0 });
    store.append(U, "abc", "hello");
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
