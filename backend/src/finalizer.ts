import { FinalizedTranscript, writeSummary } from "./transcriptStore";
import { Summarize } from "./summarizer";

/** Skip summarizing/notifying for transcripts with almost no content. */
const MIN_TRANSCRIPT_CHARS = 40;

export type SendTranscriptEmail = (
  t: FinalizedTranscript,
  summary: string,
) => Promise<void>;

export interface FinalizerOptions {
  /** Transcript directory the summary file is written to. */
  dir: string;
  /** Optional Claude summarizer. */
  summarize?: Summarize;
  /** Optional "transcript ready" email. */
  sendEmail?: SendTranscriptEmail;
}

/**
 * Runs when a session's transcript finalizes: generate + store the summary,
 * then send the notification email (including the summary when available).
 * Every step is best-effort — the transcript is already safely on disk.
 */
export function createFinalizer(opts: FinalizerOptions): (t: FinalizedTranscript) => void {
  return (t) => {
    void run(opts, t);
  };
}

async function run(opts: FinalizerOptions, t: FinalizedTranscript): Promise<void> {
  const chars = t.segments.reduce((n, s) => n + s.text.length, 0);
  if (chars < MIN_TRANSCRIPT_CHARS) return;

  let summary = "";
  if (opts.summarize) {
    try {
      summary = await opts.summarize(t);
      if (summary.length > 0) {
        writeSummary(opts.dir, t.name, summary);
        console.log(`summary written for ${t.name}`);
      }
    } catch (err) {
      console.error(`summary failed for ${t.name}:`, err);
    }
  }

  if (opts.sendEmail) {
    try {
      await opts.sendEmail(t, summary);
      console.log(`notification email sent for ${t.name}`);
    } catch (err) {
      console.error(`notification email failed for ${t.name}:`, err);
    }
  }
}
