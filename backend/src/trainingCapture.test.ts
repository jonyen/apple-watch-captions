import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { TrainingCapture } from "./trainingCapture";
import { FinalizedTranscript } from "./transcriptStore";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "training-capture-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function finalized(overrides: Partial<FinalizedTranscript> = {}): FinalizedTranscript {
  return {
    name: "2026-01-01T00-00-00Z_s1",
    userId: "u1",
    sessionId: "s1",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:01:00.000Z",
    segments: [{ at: "2026-01-01T00:00:30.000Z", text: "hello world" }],
    ...overrides,
  };
}

/** A 16 kHz mono s16le PCM buffer of `n` samples (silence is fine for byte-count tests). */
function pcm(samples: number): Buffer {
  return Buffer.alloc(samples * 2);
}

describe("TrainingCapture", () => {
  it("writes nothing until audio arrives", () => {
    new TrainingCapture({ dir: root });
    expect(existsSync(join(root, ".staging"))).toBe(false);
  });

  it("produces audio.wav, transcript.txt, and meta.json for a session with audio and finals", () => {
    const capture = new TrainingCapture({ dir: root, now: () => Date.parse("2026-01-01T00:00:00.000Z") });
    capture.audio("u1", "s1", "apple", pcm(16_000)); // 1 second
    capture.audio("u1", "s1", "apple", pcm(16_000)); // another second
    capture.finalize(finalized());

    const dir = join(root, "2026-01-01T00-00-00Z_s1");
    const wav = readFileSync(join(dir, "audio.wav"));
    // RIFF/WAVE header sanity.
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(16_000); // sample rate
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
    const dataBytes = wav.readUInt32LE(40);
    expect(dataBytes).toBe(32_000 * 2); // two 1s chunks of 16-bit samples
    expect(wav.length).toBe(44 + dataBytes);

    const transcript = readFileSync(join(dir, "transcript.txt"), "utf8");
    expect(transcript).toBe("hello world\n");

    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    expect(meta.provider).toBe("apple");
    expect(meta.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(meta.durationSeconds).toBeCloseTo(2, 5);

    // Nothing left staged behind.
    expect(existsSync(join(root, ".staging", "1:u1:s1.wav"))).toBe(false);
  });

  it("writes multiple final lines, one per line, in order", () => {
    const capture = new TrainingCapture({ dir: root });
    capture.audio("u1", "s1", "apple", pcm(100));
    capture.finalize(
      finalized({
        segments: [
          { at: "t1", text: "first line" },
          { at: "t2", text: "second line" },
        ],
      }),
    );
    const transcript = readFileSync(
      join(root, "2026-01-01T00-00-00Z_s1", "transcript.txt"),
      "utf8",
    );
    expect(transcript).toBe("first line\nsecond line\n");
  });

  it("produces nothing for a caption-only session (audio() never called)", () => {
    const capture = new TrainingCapture({ dir: root });
    capture.finalize(finalized());
    expect(existsSync(join(root, "2026-01-01T00-00-00Z_s1"))).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it("cleans up a session that captured audio but ended with zero final lines", () => {
    const capture = new TrainingCapture({ dir: root });
    capture.audio("u1", "s1", "apple", pcm(100));
    // TranscriptStore.finalize never fires onFinalize when there were no
    // finals — the caller instead calls discardIfPending directly.
    capture.discardIfPending("u1", "s1");
    expect(
      readdirSync(root, { withFileTypes: true }).filter(
        (e) => e.isDirectory() && e.name !== ".staging",
      ),
    ).toEqual([]);
    expect(existsSync(join(root, ".staging", "1:u1:s1.wav"))).toBe(false);
  });

  it("discardIfPending is a no-op once finalize already claimed the session", () => {
    const capture = new TrainingCapture({ dir: root });
    capture.audio("u1", "s1", "apple", pcm(100));
    capture.finalize(finalized());
    expect(existsSync(join(root, "2026-01-01T00-00-00Z_s1", "audio.wav"))).toBe(true);
    capture.discardIfPending("u1", "s1"); // must not remove what finalize just wrote
    expect(existsSync(join(root, "2026-01-01T00-00-00Z_s1", "audio.wav"))).toBe(true);
  });

  it("discardIfPending is a no-op when nothing was ever captured", () => {
    const capture = new TrainingCapture({ dir: root });
    expect(() => capture.discardIfPending("u1", "unknown")).not.toThrow();
  });

  it("keeps sessions for different users/ids apart", () => {
    const capture = new TrainingCapture({ dir: root });
    capture.audio("u1", "s1", "apple", pcm(10));
    capture.audio("u2", "s1", "apple", pcm(20));
    capture.finalize(finalized({ userId: "u1", sessionId: "s1", name: "2026-01-01T00-00-00Z_s1" }));
    capture.finalize(finalized({ userId: "u2", sessionId: "s1", name: "2026-01-01T00-00-01Z_s1" }));

    const wav1 = readFileSync(join(root, "2026-01-01T00-00-00Z_s1", "audio.wav"));
    const wav2 = readFileSync(join(root, "2026-01-01T00-00-01Z_s1", "audio.wav"));
    expect(wav1.readUInt32LE(40)).toBe(20);
    expect(wav2.readUInt32LE(40)).toBe(40);
  });

  it("swallows and logs a failure writing audio, without throwing", () => {
    const capture = new TrainingCapture({ dir: "\0invalid" });
    expect(() => capture.audio("u1", "s1", "apple", pcm(10))).not.toThrow();
  });

  it("swallows and logs a finalize failure, without throwing", () => {
    const capture = new TrainingCapture({ dir: root });
    capture.audio("u1", "s1", "apple", pcm(10));
    // Make the destination collide with a file so mkdirSync(destDir) throws.
    const badName = "collides";
    writeFileSync(join(root, badName), "not a directory");
    expect(() =>
      capture.finalize(finalized({ name: badName })),
    ).not.toThrow();
  });

  it("prunes the oldest session directories first once over the cap", () => {
    // Each session's audio.wav is ~100 KB; transcript.txt/meta.json are a few
    // hundred bytes at most, so a cap of 150 KB fits one session but not two.
    const capture = new TrainingCapture({ dir: root, maxBytes: 150_000 });
    for (const [name, sessionId] of [
      ["2026-01-01T00-00-00Z_s1", "s1"],
      ["2026-01-01T00-00-01Z_s2", "s2"],
      ["2026-01-01T00-00-02Z_s3", "s3"],
    ] as const) {
      capture.audio("u1", sessionId, "apple", pcm(50_000));
      capture.finalize(finalized({ sessionId, name }));
    }

    const remaining = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== ".staging")
      .map((e) => e.name)
      .sort();

    // Oldest ("...00-00Z_s1") deleted first; the newest survives.
    expect(remaining).not.toContain("2026-01-01T00-00-00Z_s1");
    expect(remaining).toContain("2026-01-01T00-00-02Z_s3");
  });

  it("never deletes anything outside its own directory while pruning", () => {
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    try {
      const capture = new TrainingCapture({ dir: root, maxBytes: 1 });
      capture.audio("u1", "s1", "apple", pcm(500));
      capture.finalize(finalized());
      expect(existsSync(outside)).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
