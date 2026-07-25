import { ExportMarker, FinalizedTranscript } from "./transcriptStore";
import { parseSummary } from "./summaryPrompt";
import { batches, markdownToBlocks, paragraph } from "./notionBlocks";
import {
  NotionExporterOptions,
  Request,
  appendChildren,
  appendToggle,
  createRequest,
  label,
  pageTitle,
  readSchema,
} from "./notionExporter";

const SUMMARY_TOGGLE = "Summary";
const TRANSCRIPT_TOGGLE = "Full transcript";

export interface UpdateResult {
  pageId: string;
  url: string;
  /** Segments now present on the page, to store back in the marker. */
  exportedSegments: number;
}

export type UpdateExport = (
  transcript: FinalizedTranscript,
  summary: string | null,
  marker: ExportMarker,
) => Promise<UpdateResult>;

/**
 * Brings an already-exported page up to date after a session was resumed:
 * replaces the stale summary, appends only the new caption lines, and retitles
 * the page.
 *
 * The page's own blocks are the source of truth for where things live — the
 * toggles are found by their titles rather than by ids stored in the marker,
 * so pages exported before resume existed are handled without migration.
 */
export function createNotionUpdater(opts: NotionExporterOptions): UpdateExport {
  const request = createRequest(opts);
  let titleProperty: Promise<string> | undefined;

  return async (transcript, summary, marker) => {
    const { pageId } = marker;
    const parsed = parseSummary(summary ?? "");
    const existing = await findToggles(request, pageId);

    // 1. The old summary describes a shorter transcript; replace it wholesale.
    if (existing.summary) await request(`/blocks/${existing.summary}`, "DELETE");
    const summaryBlocks = summary ? markdownToBlocks(parsed.body) : [];
    if (summaryBlocks.length > 0) {
      await appendToggle(request, pageId, SUMMARY_TOGGLE, summaryBlocks);
    }

    // 2. Append only what the page does not already have.
    const alreadyExported = marker.exportedSegments ?? 0;
    const fresh = transcript.segments.slice(alreadyExported).flatMap((s) => paragraph(label(s)));
    if (fresh.length > 0) {
      if (existing.transcript) {
        for (const batch of batches(fresh)) {
          await appendChildren(request, existing.transcript, batch);
        }
      } else {
        await appendToggle(request, pageId, TRANSCRIPT_TOGGLE, fresh);
      }
    }

    // 3. A resumed session may have moved on to a different topic.
    if (parsed.title) {
      titleProperty ??= request(`/databases/${opts.databaseId}`, "GET")
        .then(readSchema)
        .then((schema) => schema.titleProperty)
        .catch((err) => {
          titleProperty = undefined;
          throw err;
        });
      const property = await titleProperty;
      await request(`/pages/${pageId}`, "PATCH", {
        properties: {
          [property]: {
            title: [{ type: "text", text: { content: pageTitle(transcript, parsed.title) } }],
          },
        },
      });
    }

    return { pageId, url: marker.url, exportedSegments: transcript.segments.length };
  };
}

/** Locate the page's Summary and Full transcript toggles by their titles. */
async function findToggles(
  request: Request,
  pageId: string,
): Promise<{ summary?: string; transcript?: string }> {
  const page = await request(`/blocks/${pageId}/children?page_size=100`, "GET");
  const found: { summary?: string; transcript?: string } = {};
  for (const block of page?.results ?? []) {
    if (block?.type !== "toggle") continue;
    const text = (block.toggle?.rich_text ?? [])
      .map((r: any) => r?.plain_text ?? r?.text?.content ?? "")
      .join("");
    if (text === SUMMARY_TOGGLE) found.summary ??= block.id;
    if (text === TRANSCRIPT_TOGGLE) found.transcript ??= block.id;
  }
  return found;
}
