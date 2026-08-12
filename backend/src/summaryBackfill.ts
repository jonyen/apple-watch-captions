import {
  listTranscripts,
  readExportMarker,
  readTranscript,
  rebuildFinalized,
  writeSummary,
} from "./transcriptStore";
import { Summarize } from "./summarizer";
import { isSubstantial } from "./finalizer";

export interface SummaryBackfillOptions {
  dir: string;
  summarize: Summarize;
  /**
   * Optional: add the freshly generated summary to a Notion page that was
   * already exported without one. Skipped for transcripts never exported.
   */
  patchPage?: (pageId: string, summary: string) => Promise<void>;
  /** Stop after this many summaries (each one is a paid model call). */
  limit?: number;
  /** Pause between transcripts, to stay clear of API rate limits. */
  delayMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Re-summarize transcripts that already have a summary. Off by default: the
   * summary file is the done-marker, and the boot-time sweep must stay cheap.
   */
  force?: boolean;
}

export interface SummaryBackfillResult {
  summarized: number;
  skipped: number;
  failed: number;
  patched: number;
}

/**
 * Generates summaries for stored transcripts that never got one — sessions
 * that ended while the Anthropic key was unset, out of credit, or erroring.
 *
 * The summary file is the marker: without `force`, a transcript with
 * `<name>.summary.md` is never summarized twice, so a plain re-run is safe.
 * Under `force: true` every stored transcript is a candidate again, so
 * re-running is no longer automatically safe — pair it with a `limit` to
 * bound the number of paid model calls.
 */
export async function backfillSummaries(
  opts: SummaryBackfillOptions,
): Promise<SummaryBackfillResult> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const delayMs = opts.delayMs ?? 1000;
  const result: SummaryBackfillResult = { summarized: 0, skipped: 0, failed: 0, patched: 0 };
  // Counts model calls actually made (success or failure), not just
  // successes — `limit` bounds paid calls, so a run of systematic failures
  // (e.g. every transcript exceeding the token ceiling) must not keep
  // walking the archive looking for `limit` successes that never come.
  let attempts = 0;

  for (const listed of listTranscripts(opts.dir)) {
    if (opts.limit !== undefined && attempts >= opts.limit) break;
    if (listed.hasSummary && !opts.force) {
      result.skipped++;
      continue;
    }
    const detail = readTranscript(opts.dir, listed.name);
    if (!detail) {
      result.skipped++;
      continue;
    }
    const transcript = rebuildFinalized(listed.name, detail.segments);
    if (!isSubstantial(transcript)) {
      result.skipped++;
      continue;
    }

    if (delayMs > 0) await sleep(delayMs);

    attempts++;
    let summary: string;
    try {
      summary = await opts.summarize(transcript);
    } catch (err) {
      console.error(`summary failed for ${listed.name}:`, err);
      result.failed++;
      continue;
    }
    if (summary.length === 0) {
      console.error(`summary for ${listed.name} came back empty`);
      result.failed++;
      continue;
    }

    writeSummary(opts.dir, listed.name, summary);
    result.summarized++;
    console.log(`summary written for ${listed.name}`);

    // The transcript may already be a Notion page created before the summary
    // existed. Update that page rather than exporting a duplicate.
    const marker = readExportMarker(opts.dir, listed.name);
    if (opts.patchPage && marker) {
      try {
        await opts.patchPage(marker.pageId, summary);
        result.patched++;
        console.log(`summary added to ${marker.url}`);
      } catch (err) {
        // The summary is on disk; only the Notion page is behind.
        console.error(`page update failed for ${listed.name}:`, err);
      }
    }
  }
  return result;
}
