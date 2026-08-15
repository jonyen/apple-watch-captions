import { mkdirSync } from "fs";
import {
  FinalizedTranscript,
  MIN_TRANSCRIPT_CHARS,
  readExportMarker,
  writeExportMarker,
  writeSummary,
  userDir,
} from "./transcriptStore";
import { Summarize } from "./summarizer";
import { ExportTranscript, PatchSummary } from "./notionExporter";
import { UpdateExport } from "./notionUpdater";

export interface UserExporters {
  export: ExportTranscript;
  update: UpdateExport;
  patchSummary: PatchSummary;
}

/** That user's Notion connection, or undefined if they have not connected one. */
export type ResolveExporters = (userId: string) => UserExporters | undefined;

export interface FinalizerOptions {
  /** Root transcript directory; the per-user summary directory is derived from `t.userId`. */
  root: string;
  /** Optional Claude summarizer. */
  summarize?: Summarize;
  /**
   * Resolved per transcript rather than captured once, because each user
   * exports to their own workspace with their own credentials.
   */
  resolve?: ResolveExporters;
}

/**
 * Runs when a session's transcript finalizes: generate + store the summary,
 * then push it to Notion if configured.
 * Best-effort — the transcript is already safely on disk.
 */
export function createFinalizer(opts: FinalizerOptions): (t: FinalizedTranscript) => void {
  return (t) => {
    void run(opts, t);
  };
}

/** Transcripts below the content floor aren't worth summarizing or exporting. */
export function isSubstantial(t: FinalizedTranscript): boolean {
  return t.segments.reduce((n, s) => n + s.text.length, 0) >= MIN_TRANSCRIPT_CHARS;
}

async function run(opts: FinalizerOptions, t: FinalizedTranscript): Promise<void> {
  if (!isSubstantial(t)) return;

  // Resolved up front (rather than at the export step below) so the
  // "nothing to do" check just below is honest: `opts.resolve` being set
  // does not mean *this* user has a connection, and `resolveExporters` in
  // `index.ts` is always set even when export destinations are disabled
  // entirely. Wrapped in `try` for the same reason the block below is: a
  // sealed secret that fails to open (rotated key, restored database) must
  // not become an unhandled promise rejection — `createFinalizer` invokes
  // `run` fire-and-forget as `void run(opts, t)`, and by default an
  // unhandled rejection kills the whole process, for every user, on every
  // finalize.
  let exporters: UserExporters | undefined;
  try {
    exporters = opts.resolve?.(t.userId);
  } catch (err) {
    console.error(`could not resolve export destination for ${t.name}:`, err);
  }

  // Nothing below here writes anything, so there is nothing worth creating a
  // directory for.
  if (!opts.summarize && !exporters) return;

  let dir: string;
  try {
    dir = userDir(opts.root, t.userId);
    // In the live flow this directory already exists — `TranscriptStore.append`
    // created it before the session could ever reach `finalize` — but nothing
    // else guarantees that (a directly-constructed `FinalizedTranscript`, or a
    // future backfill re-running this path), and `writeSummary`/
    // `writeExportMarker` do not create directories themselves.
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    // Best-effort, like the rest of this function: the transcript is
    // already safely on disk. This must not become an unhandled promise
    // rejection — `createFinalizer` invokes `run` fire-and-forget as
    // `void run(opts, t)`, and by default an unhandled rejection kills the
    // whole process. Reachable on an unsafe/empty `userId` (`userDir`
    // throws), `EACCES`, `ENOSPC`, or `root` having been replaced by a
    // plain file.
    console.error(`could not resolve transcript directory for ${t.name}:`, err);
    return;
  }

  let summary: string | null = null;
  if (opts.summarize) {
    try {
      const generated = await opts.summarize(t);
      if (generated.length > 0) {
        summary = generated;
        writeSummary(dir, t.name, generated);
        console.log(`summary written for ${t.name}`);
      }
    } catch (err) {
      console.error(`summary failed for ${t.name}:`, err);
    }
  }

  // Export independently of the summary: a transcript is still worth having in
  // Notion when Claude is unconfigured or the summary call failed.
  if (exporters) {
    await exportOnce(exporters.export, dir, t, summary, exporters.update);
  }
}

/**
 * Send this transcript to Notion. A transcript with no marker is created; one
 * that already has a page is updated in place when an updater is configured
 * (a resumed session), and otherwise left alone.
 *
 * The marker is written only after Notion confirms, so a failure stays
 * retryable and never loses the previous export accounting.
 */
export async function exportOnce(
  exportTranscript: ExportTranscript,
  dir: string,
  t: FinalizedTranscript,
  summary: string | null,
  update?: UpdateExport,
): Promise<boolean> {
  const marker = readExportMarker(dir, t.name);

  if (marker) {
    if (!update) return false;
    try {
      const result = await update(t, summary, marker);
      writeExportMarker(dir, t.name, result);
      console.log(`updated ${t.name} at ${result.url}`);
      return true;
    } catch (err) {
      console.error(`page update failed for ${t.name}:`, err);
      return false;
    }
  }

  try {
    const result = await exportTranscript(t, summary);
    writeExportMarker(dir, t.name, {
      ...result,
      exportedSegments: t.segments.length,
    });
    console.log(`exported ${t.name} to ${result.url}`);
    return true;
  } catch (err) {
    console.error(`export failed for ${t.name}:`, err);
    return false;
  }
}
