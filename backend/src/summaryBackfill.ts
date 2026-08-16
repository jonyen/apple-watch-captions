import {
  listTranscripts,
  readExportMarker,
  readTranscript,
  rebuildFinalized,
  writeSummary,
} from "./transcriptStore";
import { Summarize } from "./summarizer";
import { ResolveExporters, UserExporters, isSubstantial } from "./finalizer";

export interface SummaryBackfillOptions {
  dir: string;
  /**
   * Who owns `dir`. Required rather than defaulted: the sweep runs once per
   * user directory and always knows the answer, and a rebuilt transcript with
   * an empty `userId` is exactly what `finalizer.run` (and the per-user
   * export work that will read it) cannot use.
   */
  userId: string;
  summarize: Summarize;
  /**
   * Optional: this user's Notion connection, used to add the freshly
   * generated summary to a page that was already exported without one. A
   * user with no connection (`resolve` unset, or it returns `undefined` for
   * them) still gets their summaries generated and written to disk — that is
   * local work with nothing to do with Notion — the patch step is just
   * skipped.
   */
  resolve?: ResolveExporters;
  /** Stop after this many summaries (each one is a paid model call). */
  limit?: number;
  /**
   * Re-summarize transcripts that already have a summary. Off by default: the
   * summary file is the done-marker, and the boot-time sweep must stay cheap.
   */
  force?: boolean;
  /** Pause between transcripts, to stay clear of API rate limits. */
  delayMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
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
 * The summary file is the marker: a transcript with `<name>.summary.md` is
 * never summarized twice, so this is safe to re-run.
 */
export async function backfillSummaries(
  opts: SummaryBackfillOptions,
): Promise<SummaryBackfillResult> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const delayMs = opts.delayMs ?? 1000;
  const result: SummaryBackfillResult = { summarized: 0, skipped: 0, failed: 0, patched: 0 };

  // Guarded per user, same as `backfillNotion`: this sweep runs once per
  // user directory in a loop over every user, and a sealed secret that fails
  // to open for one of them must not abort summarizing for everyone after
  // them in the loop — nor should it, on its own, stop *this* user's
  // summaries from being generated (see `resolve` above).
  let exporters: UserExporters | undefined;
  try {
    exporters = opts.resolve?.(opts.userId);
  } catch (err) {
    console.error(`could not resolve Notion connection for ${opts.userId}:`, err);
  }

  // Counts model calls actually made (success or failure), not just
  // successes — `limit` bounds paid calls, so a run of systematic failures
  // (e.g. every transcript exceeding the token ceiling) must not keep
  // walking the archive looking for `limit` successes that never come.
  let attempts = 0;

  for (const listed of listTranscripts(opts.dir).reverse()) {
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
    const transcript = rebuildFinalized(listed.name, detail.segments, opts.userId);
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
    if (exporters?.patchSummary && marker) {
      try {
        await exporters.patchSummary(marker.pageId, summary);
        result.patched++;
        console.log(`summary added to ${marker.url}`);
      } catch (err) {
        // The summary is on disk; only the Notion page is behind.
        console.error(`page update failed for ${listed.name}:`, err);
        // A 401 revoked the connection, and `exporters` still wraps the dead
        // token. Drop it so the rest of the sweep keeps writing summaries to
        // disk — that part has nothing to do with Notion — without retrying a
        // credential that cannot work again.
        if (opts.resolve && !opts.resolve(opts.userId)) {
          console.error(
            `Notion connection for ${opts.userId} was revoked mid-sweep; ` +
              `remaining summaries are written locally only`,
          );
          exporters = undefined;
        }
      }
    }
  }
  return result;
}
