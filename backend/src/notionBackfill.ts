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
    const done = await exportOnce(exporters.export, opts.dir, transcript, detail.summary);
    done ? result.exported++ : result.failed++;
  }
  return result;
}
