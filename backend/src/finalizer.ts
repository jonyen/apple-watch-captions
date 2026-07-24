import {
  FinalizedTranscript,
  readExportMarker,
  writeExportMarker,
  writeSummary,
} from "./transcriptStore";
import { Summarize } from "./summarizer";
import { ExportTranscript } from "./notionExporter";

/** Skip summarizing and exporting transcripts with almost no content. */
const MIN_TRANSCRIPT_CHARS = 40;

export interface FinalizerOptions {
  /** Transcript directory the summary file is written to. */
  dir: string;
  /** Optional Claude summarizer. */
  summarize?: Summarize;
  /** Optional external export (Notion). */
  export?: ExportTranscript;
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
  if (opts.export) await exportOnce(opts.export, opts.dir, t, summary);
}

/**
 * Export unless this transcript already has a marker. The marker is written
 * only after Notion confirms the page, so a failed export stays retryable.
 */
export async function exportOnce(
  exportTranscript: ExportTranscript,
  dir: string,
  t: FinalizedTranscript,
  summary: string | null,
): Promise<boolean> {
  if (readExportMarker(dir, t.name)) return false;
  try {
    const result = await exportTranscript(t, summary);
    writeExportMarker(dir, t.name, result);
    console.log(`exported ${t.name} to ${result.url}`);
    return true;
  } catch (err) {
    console.error(`export failed for ${t.name}:`, err);
    return false;
  }
}
