import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  TranscriptStore,
  FinalizedTranscript,
  listTranscripts,
  readTranscript,
  writeSummary,
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

  it("rejects path-traversal names on read", () => {
    expect(readTranscript(dir, "../etc/passwd")).toBeNull();
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
  });
});
