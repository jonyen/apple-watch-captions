import {
  FinalizedTranscript,
  readExportMarker,
  writeExportMarker,
  writeSummary,
} from "./transcriptStore";
import { Summarize } from "./summarizer";
import { ExportTranscript } from "./notionExporter";
import { UpdateExport } from "./notionUpdater";

/** Skip summarizing and exporting transcripts with almost no content. */
const MIN_TRANSCRIPT_CHARS = 40;

export interface FinalizerOptions {
  /** Transcript directory the summary file is written to. */
  dir: string;
  /** Optional Claude summarizer. */
  summarize?: Summarize;
  /** Optional external export (Notion). */
  export?: ExportTranscript;
  /** Optional in-place update, used when a resumed session ends. */
  update?: UpdateExport;
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

  let summary: string | null = null;
  if (opts.summarize) {
    try {
      const generated = await opts.summarize(t);
      if (generated.length > 0) {
        summary = generated;
        writeSummary(opts.dir, t.name, generated);
        console.log(`summary written for ${t.name}`);
      }
    } catch (err) {
      console.error(`summary failed for ${t.name}:`, err);
    }
  }

  // Export independently of the summary: a transcript is still worth having in
  // Notion when Claude is unconfigured or the summary call failed.
  if (opts.export) await exportOnce(opts.export, opts.dir, t, summary, opts.update);
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
