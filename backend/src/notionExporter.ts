import { FinalizedTranscript, TranscriptSegment } from "./transcriptStore";
import { NotionBlock, batches, markdownToBlocks, paragraph, toggle } from "./notionBlocks";
import { parseSummary } from "./summaryPrompt";

const API = "https://api.notion.com/v1";
// Exported so other Notion callers (e.g. notionOAuth's post-grant database
// search) send the same version rather than a copy that can drift from it.
export const NOTION_VERSION = "2022-06-28";

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
 * Exports transcripts as pages in a Notion database: a collapsed Summary
 * toggle and a collapsed Full transcript toggle.
 *
 * Property names are read from the database schema rather than assumed, so
 * whatever the user named their title column works, and the optional
 * Started/Ended/Segments/Session columns are filled only if they exist.
 */
export type Request = (path: string, method: string, body?: unknown) => Promise<any>;

/**
 * A non-2xx answer from Notion, carrying the status as data rather than only
 * inside the message.
 *
 * Callers need to tell a revoked token (401) from a transient failure, and
 * regex-matching a message string is the wrong way to make a decision that
 * disables someone's export. The message text is unchanged, so anything that
 * only logs the error reads exactly as before.
 */
export class NotionApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "NotionApiError";
  }
}

/** Authenticated Notion request that throws with the API's status and message. */
export function createRequest(opts: NotionExporterOptions): Request {
  const doFetch = opts.fetch ?? ((url, init) => fetch(url, init));
  return async (path, method, body) => {
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
      throw new NotionApiError(
        `Notion ${method} ${path} failed: ${response.status} ${message}`,
        response.status,
      );
    }
    return payload;
  };
}

/** Adds a Summary toggle to an already-exported page. */
export type PatchSummary = (pageId: string, summary: string) => Promise<void>;

/**
 * Adds a Summary toggle to a page that was exported before its summary
 * existed — used by the summary backfill so it updates the page in place
 * instead of creating a duplicate.
 *
 * The toggle lands after the transcript on these pages, since Notion's append
 * API has no prepend; freshly exported pages still get Summary first.
 */
export function createNotionSummaryPatcher(opts: NotionExporterOptions): PatchSummary {
  const request = createRequest(opts);
  return async (pageId, summary) => {
    const blocks = markdownToBlocks(parseSummary(summary).body);
    if (blocks.length === 0) return;
    await appendToggle(request, pageId, "Summary", blocks);
  };
}

/**
 * Renames an existing page. Used to give pages exported before titles existed
 * a descriptive name, and by the resume path when a session's topic moves on.
 */
export function createNotionTitlePatcher(
  opts: NotionExporterOptions,
): (pageId: string, title: string) => Promise<void> {
  const request = createRequest(opts);
  let schema: Promise<DatabaseSchema> | undefined;
  return async (pageId, title) => {
    schema ??= request(`/databases/${opts.databaseId}`, "GET")
      .then(readSchema)
      .catch((err) => {
        schema = undefined;
        throw err;
      });
    const { titleProperty } = await schema;
    await request(`/pages/${pageId}`, "PATCH", {
      properties: { [titleProperty]: { title: [{ type: "text", text: { content: title } }] } },
    });
  };
}

export function createNotionExporter(opts: NotionExporterOptions): ExportTranscript {
  const request = createRequest(opts);
  let schema: Promise<DatabaseSchema> | undefined;

  return async (transcript, summary) => {
    // Cache the schema, but never cache a failure: a Notion blip during the
    // first export would otherwise poison every export for the process's life.
    schema ??= request(`/databases/${opts.databaseId}`, "GET")
      .then(readSchema)
      .catch((err) => {
        schema = undefined;
        throw err;
      });
    const parsed = parseSummary(summary ?? "");
    const properties = buildProperties(await schema, transcript, parsed.title);

    const page = await request("/pages", "POST", {
      parent: { database_id: opts.databaseId },
      properties,
    });
    const pageId = page.id as string;

    // Two collapsed sections: the summary and the raw transcript. Both are
    // appended rather than created with the page, so each response hands back
    // its toggle's block id and content longer than one request nests under it.
    const summaryBlocks = summary ? markdownToBlocks(parsed.body) : [];
    if (summaryBlocks.length > 0) {
      await appendToggle(request, pageId, "Summary", summaryBlocks);
    }

    const lines = transcript.segments.flatMap((s) => paragraph(label(s)));
    await appendToggle(request, pageId, "Full transcript", lines);

    return { pageId, url: page.url as string };
  };
}

/** Append a collapsed section, nesting any overflow beyond one request inside it. */
export async function appendToggle(
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

export function appendChildren(
  request: (path: string, method: string, body?: unknown) => Promise<any>,
  blockId: string,
  children: NotionBlock[],
): Promise<any> {
  return request(`/blocks/${blockId}/children`, "PATCH", { children });
}

/** `Me:`/`Them:` prefixes for dual-channel sessions, matching the summarizer. */
export function label(segment: TranscriptSegment): string {
  if (segment.channel === 0) return `Me: ${segment.text}`;
  if (segment.channel === 1) return `Them: ${segment.text}`;
  return segment.text;
}

export interface DatabaseSchema {
  /** Name of the database's title property, whatever the user called it. */
  titleProperty: string;
  types: Record<string, string>;
}

export function readSchema(database: any): DatabaseSchema {
  const properties: Record<string, { type: string }> = database?.properties ?? {};
  const types = Object.fromEntries(Object.entries(properties).map(([k, v]) => [k, v.type]));
  const titleProperty = Object.keys(types).find((k) => types[k] === "title");
  if (!titleProperty) {
    throw new Error("Notion database has no title property");
  }
  return { titleProperty, types };
}

function buildProperties(
  schema: DatabaseSchema,
  t: FinalizedTranscript,
  summaryTitle?: string,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    [schema.titleProperty]: {
      title: [{ type: "text", text: { content: pageTitle(t, summaryTitle) } }],
    },
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

/**
 * `2026-07-06 01:02 — Vendor call about code review`, or the plain dated form
 * when the summary carried no title. Both sort naturally and are
 * timezone-stable.
 */
export function pageTitle(t: FinalizedTranscript, summaryTitle?: string): string {
  const [date, time = ""] = t.startedAt.split("T");
  const when = `${date} ${time.slice(0, 5)}`.trim();
  return summaryTitle ? `${when} — ${summaryTitle}` : `Captions ${when} UTC`;
}
