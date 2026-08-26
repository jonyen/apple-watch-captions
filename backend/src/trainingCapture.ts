import {
  openSync,
  writeSync,
  closeSync,
  rmSync,
  mkdirSync,
  renameSync,
  writeFileSync,
  readdirSync,
  statSync,
  existsSync,
} from "fs";
import { join } from "path";
import { FinalizedTranscript } from "./transcriptStore";

/** The PCM format every provider in this relay sends and expects: 16 kHz mono s16le. */
const SAMPLE_RATE = 16_000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;
const WAV_HEADER_BYTES = 44;

export const DEFAULT_TRAINING_CAPTURE_MAX_BYTES = 20 * 1024 * 1024 * 1024;

export interface TrainingCaptureOptions {
  /** Directory training-data session folders are written under. */
  dir: string;
  /** Prune oldest sessions once the directory exceeds this many bytes. Defaults to 20 GB. */
  maxBytes?: number;
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
  /**
   * Labels an archived session's audio offline: given the path to its
   * written WAV, returns the final transcript lines a fresh provider produced
   * for it, run faster than real time. Required for `archiveFinalize` to
   * produce a `transcript.txt` at all — without it (or if it throws), the
   * audio is kept and `meta.json` notes labeling never happened, rather than
   * losing the audio.
   */
  transcribeOffline?: (wavPath: string) => Promise<string[]>;
}

interface CaptureState {
  fd: number;
  path: string;
  bytesWritten: number;
  provider: string;
  createdAt: string;
}

interface ArchiveState {
  fd: number;
  path: string;
  bytesWritten: number;
  createdAt: string;
}

/**
 * Builds the self-labeled fine-tuning dataset: a session's raw PCM audio
 * saved beside the final transcript the configured provider produced for it.
 *
 * Two-phase, matching the fact that a session's transcript *name* is not
 * known until its first final caption (`TranscriptStore` assigns it then):
 * audio is staged under a scratch filename keyed by session as it arrives
 * (`audio`), and only promoted to `<dir>/<name>/` — alongside the transcript
 * and metadata — once the session finalizes with both audio and at least one
 * final line (`finalize`). A session that never gets both is discarded
 * (`discardIfPending`), so nothing empty is ever left on disk.
 *
 * Every public method swallows and logs its own failures — capture must
 * never be the thing that breaks a live captioning session, the same
 * philosophy `TranscriptStore.append` and `finalizer.ts` already follow.
 */
export class TrainingCapture {
  private readonly dir: string;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private readonly transcribeOffline?: (wavPath: string) => Promise<string[]>;
  private readonly states = new Map<string, CaptureState>();
  private readonly archiveStates = new Map<string, ArchiveState>();

  constructor(opts: TrainingCaptureOptions) {
    this.dir = opts.dir;
    this.maxBytes = opts.maxBytes ?? DEFAULT_TRAINING_CAPTURE_MAX_BYTES;
    this.now = opts.now ?? (() => Date.now());
    this.transcribeOffline = opts.transcribeOffline;
  }

  private key(userId: string, sessionId: string): string {
    return `${userId.length}:${userId}:${sessionId}`;
  }

  private stagingPath(key: string): string {
    const safe = key.replace(/[^A-Za-z0-9_-]/g, "_");
    return join(this.dir, ".staging", `${safe}.wav`);
  }

  /**
   * Append one chunk of raw PCM for this session, lazily opening its staging
   * file on first use. Only ever called for a session that actually has
   * audio — callers gate caption-only and ephemeral sessions out before
   * reaching here — so a staging file existing at all means real audio was
   * captured.
   */
  audio(userId: string, sessionId: string, provider: string, chunk: Buffer): void {
    if (chunk.length === 0) return;
    try {
      const key = this.key(userId, sessionId);
      let state = this.states.get(key);
      if (!state) {
        const stagingDir = join(this.dir, ".staging");
        mkdirSync(stagingDir, { recursive: true });
        const path = this.stagingPath(key);
        const fd = openSync(path, "w+");
        // Placeholder header, patched with real sizes once the session
        // finalizes and the true byte count is known.
        writeSync(fd, Buffer.alloc(WAV_HEADER_BYTES), 0, WAV_HEADER_BYTES, 0);
        state = { fd, path, bytesWritten: 0, provider, createdAt: new Date(this.now()).toISOString() };
        this.states.set(key, state);
      }
      writeSync(state.fd, chunk, 0, chunk.length, WAV_HEADER_BYTES + state.bytesWritten);
      state.bytesWritten += chunk.length;
    } catch (err) {
      console.error("training capture: audio write failed:", err);
    }
  }

  /**
   * Wired as (or chained into) `TranscriptStore`'s `onFinalize` hook: runs
   * only for a session that ended with at least one final caption line.
   * Promotes the staged audio into `<dir>/<name>/` with its transcript and
   * metadata, or — if no audio was ever captured for this session, or none
   * arrived — leaves nothing behind.
   */
  finalize(t: FinalizedTranscript): void {
    const key = this.key(t.userId, t.sessionId);
    const state = this.states.get(key);
    if (!state) return; // no audio ever captured for this session
    this.states.delete(key);

    try {
      if (state.bytesWritten === 0 || t.segments.length === 0) {
        closeSync(state.fd);
        rmSync(state.path, { force: true });
        return;
      }

      const header = buildWavHeader(state.bytesWritten);
      writeSync(state.fd, header, 0, WAV_HEADER_BYTES, 0);
      closeSync(state.fd);

      const destDir = join(this.dir, t.name);
      mkdirSync(destDir, { recursive: true });
      renameSync(state.path, join(destDir, "audio.wav"));

      const lines = t.segments.map((s) => s.text).join("\n") + "\n";
      writeFileSync(join(destDir, "transcript.txt"), lines);

      const durationSeconds = state.bytesWritten / (SAMPLE_RATE * BYTES_PER_SAMPLE * CHANNELS);
      writeFileSync(
        join(destDir, "meta.json"),
        JSON.stringify(
          { durationSeconds, createdAt: state.createdAt, provider: state.provider },
          null,
          2,
        ),
      );

      this.enforceCap();
    } catch (err) {
      console.error(`training capture: finalize failed for ${t.name}:`, err);
    }
  }

  /**
   * Clean up a session's staged audio when it ends without ever reaching
   * `finalize` above — a session with audio but zero final caption lines,
   * which `TranscriptStore.finalize` skips entirely (its `onFinalize` hook
   * only fires when at least one final was appended). Callers invoke this
   * right after asking `TranscriptStore` to finalize the same session;
   * if `finalize` above already claimed (and removed) this session's state,
   * this is a no-op.
   */
  discardIfPending(userId: string, sessionId: string): void {
    const key = this.key(userId, sessionId);
    const state = this.states.get(key);
    if (!state) return;
    this.states.delete(key);
    try {
      closeSync(state.fd);
      rmSync(state.path, { force: true });
    } catch (err) {
      console.error("training capture: discard failed:", err);
    }
  }

  /**
   * Append one chunk of raw PCM for an archived (kept-on-device) session —
   * `POST /v1/audio-archive`'s storage-only path. Lazily opens its own
   * staging file, entirely separate from `audio`/`states` above (a session
   * can be caption-only *and* archiving at once — orthogonal capabilities —
   * and must not collide with each other's staging file).
   */
  archiveAudio(userId: string, sessionId: string, chunk: Buffer): void {
    if (chunk.length === 0) return;
    try {
      const key = this.key(userId, sessionId);
      let state = this.archiveStates.get(key);
      if (!state) {
        const stagingDir = join(this.dir, ".staging");
        mkdirSync(stagingDir, { recursive: true });
        const safe = key.replace(/[^A-Za-z0-9_-]/g, "_");
        const path = join(stagingDir, `archive-${safe}.wav`);
        const fd = openSync(path, "w+");
        writeSync(fd, Buffer.alloc(WAV_HEADER_BYTES), 0, WAV_HEADER_BYTES, 0);
        state = { fd, path, bytesWritten: 0, createdAt: new Date(this.now()).toISOString() };
        this.archiveStates.set(key, state);
      }
      writeSync(state.fd, chunk, 0, chunk.length, WAV_HEADER_BYTES + state.bytesWritten);
      state.bytesWritten += chunk.length;
    } catch (err) {
      console.error("training capture: archive audio write failed:", err);
    }
  }

  /**
   * Finalize an archived session: called from `SessionStore` on the same
   * session's `/v1/stop` or idle reap, regardless of whether that session
   * also has a live transcript to finalize — archiving is orthogonal to
   * that path and never touches `TranscriptStore`, so nothing archived here
   * ever creates a visible transcript-history entry. A no-op if nothing was
   * ever archived for this session (mirrors `discardIfPending`).
   *
   * Promotes the staged PCM to `<dir>/<name>/audio.wav` — deleting it
   * instead if zero bytes ever arrived — then labels it offline by running
   * it back through `transcribeOffline` (never real audio in real time: the
   * whole point is a self-labeled dataset, not a live caption). A labeling
   * failure (no `transcribeOffline` configured, or it throws/rejects) is
   * logged and never loses the audio: `meta.json` is written either way,
   * noting `labelsPending: true` when labeling didn't happen.
   */
  async archiveFinalize(userId: string, sessionId: string): Promise<void> {
    const key = this.key(userId, sessionId);
    const state = this.archiveStates.get(key);
    if (!state) return;
    this.archiveStates.delete(key);

    let destDir: string;
    try {
      if (state.bytesWritten === 0) {
        closeSync(state.fd);
        rmSync(state.path, { force: true });
        return;
      }

      const header = buildWavHeader(state.bytesWritten);
      writeSync(state.fd, header, 0, WAV_HEADER_BYTES, 0);
      closeSync(state.fd);

      const name = archiveDirName(state.createdAt, sessionId);
      destDir = join(this.dir, name);
      mkdirSync(destDir, { recursive: true });
      renameSync(state.path, join(destDir, "audio.wav"));
    } catch (err) {
      console.error(`training capture: archive finalize failed for ${sessionId}:`, err);
      return;
    }

    const durationSeconds = state.bytesWritten / (SAMPLE_RATE * BYTES_PER_SAMPLE * CHANNELS);
    const baseMeta = { durationSeconds, createdAt: state.createdAt, provider: "apple-offline" };
    try {
      if (!this.transcribeOffline) throw new Error("no offline transcriber configured");
      const lines = await this.transcribeOffline(join(destDir, "audio.wav"));
      writeFileSync(
        join(destDir, "transcript.txt"),
        lines.length > 0 ? lines.join("\n") + "\n" : "",
      );
      writeFileSync(join(destDir, "meta.json"), JSON.stringify(baseMeta, null, 2));
    } catch (err) {
      console.error(`training capture: offline labeling failed for ${sessionId}:`, err);
      writeFileSync(
        join(destDir, "meta.json"),
        JSON.stringify({ ...baseMeta, labelsPending: true }, null, 2),
      );
    }

    this.enforceCap();
  }

  /**
   * Delete the oldest session directories until the capture directory's
   * total size is back under `maxBytes`. Session directory names are
   * transcript names, which sort chronologically (see `transcriptName` in
   * transcriptStore.ts) — a plain lexicographic sort is enough to find the
   * oldest. Never touches `.staging` (in-flight sessions) or anything
   * outside this directory — deleting training captures never touches
   * transcripts proper, which live under a different root entirely.
   */
  private enforceCap(): void {
    try {
      if (!existsSync(this.dir)) return;
      const entries = readdirSync(this.dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name !== ".staging")
        .map((e) => e.name)
        .sort();

      const sizes = new Map<string, number>();
      let total = 0;
      for (const name of entries) {
        const size = dirSize(join(this.dir, name));
        sizes.set(name, size);
        total += size;
      }

      for (const name of entries) {
        if (total <= this.maxBytes) break;
        rmSync(join(this.dir, name), { recursive: true, force: true });
        total -= sizes.get(name) ?? 0;
      }
    } catch (err) {
      console.error("training capture: cap enforcement failed:", err);
    }
  }
}

function dirSize(dir: string): number {
  let total = 0;
  for (const name of readdirSync(dir)) {
    try {
      total += statSync(join(dir, name)).size;
    } catch {
      // Ignore a file that vanished mid-walk; a stale total here only ever
      // makes pruning slightly less aggressive, never incorrect in a way
      // that loses live sessions.
    }
  }
  return total;
}

/**
 * `2026-07-06T01-02-03Z_archive-<session>`; filesystem-safe, sorts
 * chronologically alongside ordinary transcript names, and the `archive-`
 * tag keeps an archived-session directory visually distinct from one a live
 * transcript produced, even though both live under the same capture root.
 */
function archiveDirName(isoStart: string, sessionId: string): string {
  const ts = isoStart.replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
  const safeId = sessionId.replace(/[^A-Za-z0-9-]/g, "").slice(0, 64) || "session";
  return `${ts}_archive-${safeId}`;
}

/** A canonical 44-byte PCM WAV header for 16 kHz mono s16le audio. */
function buildWavHeader(dataBytes: number): Buffer {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  const byteRate = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;
  const blockAlign = CHANNELS * BYTES_PER_SAMPLE;

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return header;
}
