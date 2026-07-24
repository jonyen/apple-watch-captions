import {
  FinalizedTranscript,
  listTranscripts,
  readExportMarker,
  readTranscript,
} from "./transcriptStore";
import { ExportTranscript } from "./notionExporter";
import { exportOnce, isSubstantial } from "./finalizer";

export interface BackfillOptions {
  dir: string;
  export: ExportTranscript;
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
    const transcript = rebuild(listed.name, detail.segments);
    if (!isSubstantial(transcript)) {
      result.skipped++;
      continue;
    }
    if (delayMs > 0) await sleep(delayMs);
    const done = await exportOnce(opts.export, opts.dir, transcript, detail.summary);
    done ? result.exported++ : result.failed++;
  }
  return result;
}

/** Rebuild the finalized shape from what's on disk. */
function rebuild(
  name: string,
  segments: FinalizedTranscript["segments"],
): FinalizedTranscript {
  return {
    name,
    sessionId: name.slice(name.indexOf("_") + 1),
    startedAt: segments[0]?.at ?? "",
    endedAt: segments.at(-1)?.at ?? segments[0]?.at ?? "",
    segments,
  };
}
