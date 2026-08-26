import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createOfflineLabeler } from "./offlineLabeler";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "offline-labeler-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function wavFile(pcmBytes: Buffer): string {
  const header = Buffer.alloc(44); // header contents don't matter — only its length is trusted
  const path = join(dir, "audio.wav");
  writeFileSync(path, Buffer.concat([header, pcmBytes]));
  return path;
}

describe("createOfflineLabeler", () => {
  it("holds audio until ready, then streams the WAV's PCM (skipping the 44-byte header) and resolves with its finals", async () => {
    let provider!: FakeTranscriptionProvider;
    const labeler = createOfflineLabeler(() => {
      provider = new FakeTranscriptionProvider();
      return provider;
    });
    const path = wavFile(Buffer.from("some pcm bytes"));

    const resultPromise = labeler(path);
    // Not sent yet — the sidecar protocol drops audio sent before ready.
    expect(provider.receivedAudio).toHaveLength(0);

    provider.emitReady();
    expect(Buffer.concat(provider.receivedAudio).toString()).toBe("some pcm bytes");

    provider.emitTranscript({ text: "partial", isFinal: false });
    provider.emitTranscript({ text: "first final", isFinal: true });
    provider.emitTranscript({ text: "second final", isFinal: true });

    const result = await resultPromise;
    expect(result).toEqual(["first final", "second final"]);
    expect(provider.closed).toBe(true);
  });

  it("ignores empty-text transcripts", async () => {
    let provider!: FakeTranscriptionProvider;
    const labeler = createOfflineLabeler(() => {
      provider = new FakeTranscriptionProvider();
      return provider;
    });
    const resultPromise = labeler(wavFile(Buffer.from("x")));
    provider.emitReady();
    provider.emitTranscript({ text: "", isFinal: true });
    provider.emitTranscript({ text: "real", isFinal: true });
    expect(await resultPromise).toEqual(["real"]);
  });

  it("waits for close() to resolve (the provider's own bounded graceful finish) before resolving", async () => {
    let provider!: FakeTranscriptionProvider;
    let resolveClose!: () => void;
    const labeler = createOfflineLabeler(() => {
      provider = new FakeTranscriptionProvider();
      // Set before the labeler ever gets a chance to call close() on it —
      // createOfflineLabeler calls close() right after sending audio, once
      // ready, so this must be in place before that happens.
      provider.closeBarrier = new Promise((r) => {
        resolveClose = r;
      });
      return provider;
    });

    let settled = false;
    const resultPromise = labeler(wavFile(Buffer.from("x"))).then((r) => {
      settled = true;
      return r;
    });
    provider.emitReady();
    await Promise.resolve();
    await Promise.resolve();
    provider.emitTranscript({ text: "late final", isFinal: true });
    expect(settled).toBe(false);
    resolveClose();
    expect(await resultPromise).toEqual(["late final"]);
  });

  it("rejects when the provider reports an error", async () => {
    let provider!: FakeTranscriptionProvider;
    const labeler = createOfflineLabeler(() => {
      provider = new FakeTranscriptionProvider();
      return provider;
    });
    const resultPromise = labeler(wavFile(Buffer.from("x")));
    provider.emitError("sidecar unreachable");
    await expect(resultPromise).rejects.toThrow("sidecar unreachable");
  });

  it("rejects when the provider errors even before ready", async () => {
    let provider!: FakeTranscriptionProvider;
    const labeler = createOfflineLabeler(() => {
      provider = new FakeTranscriptionProvider();
      return provider;
    });
    const resultPromise = labeler(wavFile(Buffer.from("x")));
    provider.emitError("connection refused");
    await expect(resultPromise).rejects.toThrow("connection refused");
    // Never sent audio to a provider that never became ready.
    expect(provider.receivedAudio).toHaveLength(0);
  });

  it("rejects when the WAV file cannot be read", async () => {
    const labeler = createOfflineLabeler(() => new FakeTranscriptionProvider());
    await expect(labeler(join(dir, "does-not-exist.wav"))).rejects.toThrow();
  });

  it("rejects (rather than hanging forever) when the provider never becomes ready", async () => {
    vi.useFakeTimers();
    try {
      const labeler = createOfflineLabeler(() => new FakeTranscriptionProvider(), {
        readyTimeoutMs: 1000,
      });
      const resultPromise = labeler(wavFile(Buffer.from("x")));
      let rejected = false;
      resultPromise.catch(() => {
        rejected = true;
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(rejected).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(resultPromise).rejects.toThrow(/ready/);
    } finally {
      vi.useRealTimers();
    }
  });
});
