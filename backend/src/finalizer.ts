import { FinalizedTranscript, writeSummary } from "./transcriptStore";
import { Summarize } from "./summarizer";

/** Skip summarizing transcripts with almost no content. */
const MIN_TRANSCRIPT_CHARS = 40;

export interface FinalizerOptions {
  /** Transcript directory the summary file is written to. */
  dir: string;
  /** Optional Claude summarizer. */
  summarize?: Summarize;
}

/**
 * Runs when a session's transcript finalizes: generate + store the summary.
 * Best-effort — the transcript is already safely on disk.
 */
export function createFinalizer(opts: FinalizerOptions): (t: FinalizedTranscript) => void {
  return (t) => {
    void run(opts, t);
  };
}

async function run(opts: FinalizerOptions, t: FinalizedTranscript): Promise<void> {
  const chars = t.segments.reduce((n, s) => n + s.text.length, 0);
  if (chars < MIN_TRANSCRIPT_CHARS || !opts.summarize) return;
  try {
    const summary = await opts.summarize(t);
    if (summary.length > 0) {
      writeSummary(opts.dir, t.name, summary);
      console.log(`summary written for ${t.name}`);
    }
  } catch (err) {
    console.error(`summary failed for ${t.name}:`, err);
  }
}
