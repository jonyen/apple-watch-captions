import { FinalizedTranscript, TranscriptSegment } from "./transcriptStore";
import { NotionBlock, batches, markdownToBlocks, paragraph, toggle } from "./notionBlocks";

const API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

export interface ExportResult {
  pageId: string;
  url: string;
}

/** Push one finalized transcript (and its summary, if any) to an external store. */
export type ExportTranscript = (
  transcript: FinalizedTranscript,
  summary: string | null,
) => Promise<ExportResult>;

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface NotionExporterOptions {
  /** Internal integration token; the database must be shared with it. */
  token: string;
  databaseId: string;
  /** Injectable for tests. */
  fetch?: FetchLike;
}

/**
 * Exports transcripts as pages in a Notion database: summary in the body,
 * the full transcript inside a collapsed toggle.
 *
 * Property names are read from the database schema rather than assumed, so
 * whatever the user named their title column works, and the optional
 * Started/Ended/Segments/Session columns are filled only if they exist.
 */
export function createNotionExporter(opts: NotionExporterOptions): ExportTranscript {
  const doFetch = opts.fetch ?? ((url, init) => fetch(url, init));
  let schema: Promise<DatabaseSchema> | undefined;

  const request = async (path: string, method: string, body?: unknown): Promise<any> => {
    const response = await doFetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${opts.token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    } as RequestInit);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = (payload as { message?: string }).message ?? "unknown error";
      throw new Error(`Notion ${method} ${path} failed: ${response.status} ${message}`);
    }
    return payload;
  };

  return async (transcript, summary) => {
    // Cache the schema, but never cache a failure: a Notion blip during the
    // first export would otherwise poison every export for the process's life.
    schema ??= request(`/databases/${opts.databaseId}`, "GET")
      .then(readSchema)
      .catch((err) => {
        schema = undefined;
        throw err;
      });
    const properties = buildProperties(await schema, transcript);

    const page = await request("/pages", "POST", {
      parent: { database_id: opts.databaseId },
      properties,
    });
    const pageId = page.id as string;

    // Two collapsed sections: the summary and the raw transcript. Both are
    // appended rather than created with the page, so each response hands back
    // its toggle's block id and content longer than one request nests under it.
    const summaryBlocks = summary ? markdownToBlocks(summary) : [];
    if (summaryBlocks.length > 0) {
      await appendToggle(request, pageId, "Summary", summaryBlocks);
    }

    const lines = transcript.segments.flatMap((s) => paragraph(label(s)));
    await appendToggle(request, pageId, "Full transcript", lines);

    return { pageId, url: page.url as string };
  };
}

/** Append a collapsed section, nesting any overflow beyond one request inside it. */
async function appendToggle(
  request: (path: string, method: string, body?: unknown) => Promise<any>,
  pageId: string,
  title: string,
  blocks: NotionBlock[],
): Promise<void> {
  const [first = [], ...rest] = batches(blocks);
  const created = await appendChildren(request, pageId, [toggle(title, first)]);
  const toggleId = created.results?.[0]?.id as string | undefined;
  if (!toggleId) return;
  for (const batch of rest) await appendChildren(request, toggleId, batch);
}

function appendChildren(
  request: (path: string, method: string, body?: unknown) => Promise<any>,
  blockId: string,
  children: NotionBlock[],
): Promise<any> {
  return request(`/blocks/${blockId}/children`, "PATCH", { children });
}

/** `Me:`/`Them:` prefixes for dual-channel sessions, matching the summarizer. */
function label(segment: TranscriptSegment): string {
  if (segment.channel === 0) return `Me: ${segment.text}`;
  if (segment.channel === 1) return `Them: ${segment.text}`;
  return segment.text;
}

interface DatabaseSchema {
  /** Name of the database's title property, whatever the user called it. */
  titleProperty: string;
  types: Record<string, string>;
}

function readSchema(database: any): DatabaseSchema {
  const properties: Record<string, { type: string }> = database?.properties ?? {};
  const types = Object.fromEntries(Object.entries(properties).map(([k, v]) => [k, v.type]));
  const titleProperty = Object.keys(types).find((k) => types[k] === "title");
  if (!titleProperty) {
    throw new Error("Notion database has no title property");
  }
  return { titleProperty, types };
}

function buildProperties(schema: DatabaseSchema, t: FinalizedTranscript): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    [schema.titleProperty]: { title: [{ type: "text", text: { content: title(t) } }] },
  };

  const optional: Record<string, { type: string; value: unknown }> = {
    Started: { type: "date", value: { date: { start: t.startedAt } } },
    Ended: { type: "date", value: { date: { start: t.endedAt } } },
    Segments: { type: "number", value: { number: t.segments.length } },
    Session: {
      type: "rich_text",
      value: { rich_text: [{ type: "text", text: { content: t.sessionId } }] },
    },
  };
  for (const [name, { type, value }] of Object.entries(optional)) {
    // Skip the title column if the user happens to have named it one of these.
    if (name === schema.titleProperty) continue;
    if (schema.types[name] === type) properties[name] = value;
  }
  return properties;
}

/** `Captions 2026-07-06 01:02 UTC` — sorts naturally and is timezone-stable. */
function title(t: FinalizedTranscript): string {
  const [date, time = ""] = t.startedAt.split("T");
  return `Captions ${date} ${time.slice(0, 5)} UTC`.trim();
}
