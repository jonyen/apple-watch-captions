import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { FinalizedTranscript, TranscriptSegment } from "./transcriptStore";

/** Pushes a finalized transcript (and its summary) to Notion; resolves to the page id. */
export type NotionSync = (t: FinalizedTranscript, summary: string | null) => Promise<string>;

export interface NotionSyncOptions {
  apiKey: string;
  /** The Notion database the transcript pages are created in. */
  databaseId: string;
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch;
}

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
/** Notion rejects requests with more than 100 children blocks. */
const MAX_BLOCKS_PER_REQUEST = 100;
/** Notion rejects rich text elements longer than 2000 characters. */
const MAX_TEXT_CHARS = 2000;

/**
 * Creates one Notion page per transcript: title from the start time and a
 * caption preview, a Summary section (when one was generated), and the full
 * transcript as timestamped paragraphs.
 */
export function createNotionSync(opts: NotionSyncOptions): NotionSync {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers = {
    Authorization: `Bearer ${opts.apiKey}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };

  return async (t, summary) => {
    const blocks = transcriptBlocks(t, summary);
    const res = await fetchImpl(`${NOTION_API}/pages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        parent: { database_id: opts.databaseId },
        // "title" is the fixed id of a database's title property, whatever its display name.
        properties: { title: { title: richText(pageTitle(t)) } },
        children: blocks.slice(0, MAX_BLOCKS_PER_REQUEST),
      }),
    });
    if (!res.ok) {
      throw new Error(`Notion page create failed (${res.status}): ${await res.text()}`);
    }
    const page = (await res.json()) as { id: string };

    for (let i = MAX_BLOCKS_PER_REQUEST; i < blocks.length; i += MAX_BLOCKS_PER_REQUEST) {
      const append = await fetchImpl(`${NOTION_API}/blocks/${page.id}/children`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ children: blocks.slice(i, i + MAX_BLOCKS_PER_REQUEST) }),
      });
      if (!append.ok) {
        throw new Error(`Notion block append failed (${append.status}): ${await append.text()}`);
      }
    }
    return page.id;
  };
}

function pageTitle(t: FinalizedTranscript): string {
  const when = t.startedAt.replace("T", " ").replace(/(:\d{2})(\.\d+)?Z$/, "");
  const preview = t.segments
    .map((s) => s.text)
    .join(" ")
    .slice(0, 60)
    .trim();
  return preview ? `${when} — ${preview}` : when;
}

function transcriptBlocks(t: FinalizedTranscript, summary: string | null): object[] {
  const blocks: object[] = [];
  if (summary) {
    blocks.push(heading("Summary"));
    for (const line of summary.split("\n")) {
      if (line.trim().length > 0) blocks.push(paragraph(line));
    }
  }
  blocks.push(heading("Transcript"));
  for (const s of t.segments) blocks.push(paragraph(segmentLine(s)));
  return blocks;
}

/** `01:02:03 Me: the caption text` — same speaker labels the summarizer uses. */
function segmentLine(s: TranscriptSegment): string {
  const time = s.at.slice(11, 19);
  const speaker = s.channel === 0 ? "Me: " : s.channel === 1 ? "Them: " : "";
  return `${time} ${speaker}${s.text}`;
}

function heading(text: string): object {
  return { object: "block", type: "heading_2", heading_2: { rich_text: richText(text) } };
}

function paragraph(text: string): object {
  return { object: "block", type: "paragraph", paragraph: { rich_text: richText(text) } };
}

function richText(text: string): object[] {
  const chunks: object[] = [];
  for (let i = 0; i < text.length; i += MAX_TEXT_CHARS) {
    chunks.push({ type: "text", text: { content: text.slice(i, i + MAX_TEXT_CHARS) } });
  }
  return chunks.length > 0 ? chunks : [{ type: "text", text: { content: "" } }];
}

/**
 * Sync markers — `<name>.notion.json` next to the transcript records the page
 * it was synced to, so the backfill CLI never creates duplicates.
 */
export function notionPageIdFor(dir: string, name: string): string | null {
  const file = join(dir, `${name}.notion.json`);
  if (!existsSync(file)) return null;
  try {
    return (JSON.parse(readFileSync(file, "utf8")) as { pageId?: string }).pageId ?? null;
  } catch {
    return null;
  }
}

export function recordNotionPage(dir: string, name: string, pageId: string): void {
  const file = join(dir, `${name}.notion.json`);
  writeFileSync(file, JSON.stringify({ pageId, syncedAt: new Date().toISOString() }) + "\n");
}
