import {
  listTranscripts,
  readExportMarker,
  readTranscript,
  rebuildFinalized,
} from "./transcriptStore";
import { ResolveExporters, UserExporters, exportOnce, isSubstantial } from "./finalizer";

export interface BackfillOptions {
  dir: string;
  /**
   * Who owns `dir`. Required rather than defaulted: the sweep runs once per
   * user directory and always knows the answer, and a rebuilt transcript with
   * an empty `userId` is exactly what `finalizer.run` (and the per-user
   * export work that will read it) cannot use.
   */
  userId: string;
  resolve: ResolveExporters;
  /** Stop after this many exports (a boot sweep shouldn't run forever). */
  limit?: number;
  /** Pause between transcripts; Notion allows roughly 3 requests/second. */
  delayMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface BackfillResult {
  exported: number;
  skipped: number;
  failed: number;
}

/**
 * Exports every stored transcript that has no export marker, oldest first.
 *
 * Doubles as the retry path: an export that failed (relay restart, Notion
 * outage) left no marker, so the next sweep picks it up.
 */
export async function backfillNotion(opts: BackfillOptions): Promise<BackfillResult> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const delayMs = opts.delayMs ?? 400;
  const result: BackfillResult = { exported: 0, skipped: 0, failed: 0 };

  // Guarded per user: a sweep runs once per user directory in a loop over
  // every user (see `runBackfills` in `index.ts`), and a sealed secret that
  // fails to open for one of them (rotated key, restored database) must not
  // abort export catch-up for everyone after them in the loop.
  let exporters: UserExporters | undefined;
  try {
    exporters = opts.resolve(opts.userId);
  } catch (err) {
    console.error(`could not resolve Notion connection for ${opts.userId}:`, err);
    return result;
  }
  if (!exporters) return result;

  const pending = listTranscripts(opts.dir).reverse();
  for (const listed of pending) {
    if (opts.limit !== undefined && result.exported >= opts.limit) break;
    if (readExportMarker(opts.dir, listed.name)) {
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
    // Three-way, not a boolean: the loop's own marker check above and
    // `exportOnce`'s re-read are two separate reads, and a live finalize can
    // land the marker in between (this sweep runs at boot, while sessions are
    // finishing). That is ordinary, and counting it as `failed` put "Notion
    // backfill: 0 exported, 1 failed" in the boot log for a case where
    // nothing failed.
    result[await exportOnce(exporters.export, opts.dir, transcript, detail.summary)]++;

    // A 401 mid-sweep means the token is dead and revoked, and `exporters`
    // still holds a client built around it. Without this the loop would spend
    // the rest of the sweep — one paced request per pending transcript —
    // re-proving the same failure and counting each one. Re-resolving is the
    // cheapest way to notice, since a revoked connection no longer resolves.
    if (!opts.resolve(opts.userId)) {
      console.error(
        `Notion connection for ${opts.userId} was revoked mid-sweep; stopping with ` +
          `${pending.length - result.exported - result.skipped - result.failed} transcript(s) left`,
      );
      break;
    }
  }
  return result;
}
