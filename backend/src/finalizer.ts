import { FinalizedTranscript, writeSummary } from "./transcriptStore";
import { Summarize } from "./summarizer";
import { NotionSync, recordNotionPage } from "./notionSync";

/** Skip summarizing transcripts with almost no content. */
const MIN_TRANSCRIPT_CHARS = 40;

export interface FinalizerOptions {
  /** Transcript directory the summary file is written to. */
  dir: string;
  /** Optional Claude summarizer. */
  summarize?: Summarize;
  /** Optional Notion sync, run after the summary (if any) is generated. */
  notionSync?: NotionSync;
}

/**
 * Runs when a session's transcript finalizes: generate + store the summary,
 * then sync the transcript to Notion. Best-effort — the transcript is
 * already safely on disk, and a failure in one step doesn't block the other.
 */
export function createFinalizer(opts: FinalizerOptions): (t: FinalizedTranscript) => void {
  return (t) => {
    void run(opts, t);
  };
}

async function run(opts: FinalizerOptions, t: FinalizedTranscript): Promise<void> {
  let summary: string | null = null;
  const chars = t.segments.reduce((n, s) => n + s.text.length, 0);
  if (chars >= MIN_TRANSCRIPT_CHARS && opts.summarize) {
    try {
      const generated = await opts.summarize(t);
      if (generated.length > 0) {
        writeSummary(opts.dir, t.name, generated);
        summary = generated;
        console.log(`summary written for ${t.name}`);
      }
    } catch (err) {
      console.error(`summary failed for ${t.name}:`, err);
    }
  }
  if (opts.notionSync) {
    try {
      const pageId = await opts.notionSync(t, summary);
      recordNotionPage(opts.dir, t.name, pageId);
      console.log(`notion sync done for ${t.name} (page ${pageId})`);
    } catch (err) {
      console.error(`notion sync failed for ${t.name}:`, err);
    }
  }
}
