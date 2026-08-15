/**
 * Markdown → Notion block objects.
 *
 * The Notion API takes a block tree, not markdown, so the summarizer's output
 * has to be converted before it can be posted. Only the subset the summarizer
 * actually emits is supported: headings, `-`/`*` bullets, paragraphs, and
 * inline `**bold**`.
 */

/** Notion rejects any single rich-text run longer than this. */
export const MAX_TEXT = 2000;

/** Notion accepts at most this many children per create/append request. */
export const MAX_CHILDREN = 100;

export interface RichText {
  type: "text";
  text: { content: string };
  /** Omitted entirely for plain runs; Notion defaults every annotation to false. */
  annotations?: { bold: true };
}

export interface NotionBlock {
  object: "block";
  type: string;
  [body: string]: unknown;
}

type BlockType = "paragraph" | "heading_1" | "heading_2" | "heading_3" | "bulleted_list_item";

/** Convert a markdown document into Notion blocks. */
export function markdownToBlocks(markdown: string): NotionBlock[] {
  const blocks: NotionBlock[] = [];
  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length as 1 | 2 | 3;
      blocks.push(...blocksOfType(`heading_${level}` as BlockType, heading[2], inlineRichText));
      continue;
    }

    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      blocks.push(...blocksOfType("bulleted_list_item", bullet[1], inlineRichText));
      continue;
    }

    blocks.push(...blocksOfType("paragraph", line, inlineRichText));
  }
  return blocks;
}

/**
 * Plain paragraph blocks for arbitrary text (transcript lines).
 *
 * Deliberately not markdown: a caption is verbatim speech, so `**` in it is
 * something a person said, not formatting to interpret.
 */
export function paragraph(text: string): NotionBlock[] {
  return blocksOfType("paragraph", text, richText);
}

/** A collapsed toggle wrapping `children` — keeps long transcripts out of the way. */
export function toggle(title: string, children: NotionBlock[]): NotionBlock {
  return {
    object: "block",
    type: "toggle",
    toggle: { rich_text: richText(title), children },
  };
}

/** One block per `MAX_TEXT`-sized chunk, so no single run is over the limit. */
function blocksOfType(
  type: BlockType,
  text: string,
  toRuns: (content: string) => RichText[],
): NotionBlock[] {
  return chunk(text).map((content) => ({
    object: "block" as const,
    type,
    [type]: { rich_text: toRuns(content) },
  }));
}

function richText(content: string): RichText[] {
  return content.length === 0 ? [] : [{ type: "text", text: { content } }];
}

/**
 * A `**bold**` span: non-empty, and confined to one line so an unmatched marker
 * cannot swallow the rest of the document.
 */
const BOLD = /\*\*([^*\n]+)\*\*/g;

/**
 * Split text into runs, turning `**bold**` into a bold run with its markers
 * stripped. An unmatched `**` has no closing pair, so it stays literal.
 *
 * Runs are built per chunk, so a bold span straddling a `MAX_TEXT` boundary
 * keeps its markers. Summaries put bold on short bullet lead-ins, far from the
 * 2000-character mark, so this has no practical reach.
 */
function inlineRichText(content: string): RichText[] {
  const runs: RichText[] = [];
  let cursor = 0;
  for (const match of content.matchAll(BOLD)) {
    const before = content.slice(cursor, match.index);
    if (before.length > 0) runs.push({ type: "text", text: { content: before } });
    runs.push({ type: "text", text: { content: match[1] }, annotations: { bold: true } });
    cursor = match.index + match[0].length;
  }
  const rest = content.slice(cursor);
  if (rest.length > 0) runs.push({ type: "text", text: { content: rest } });
  return runs;
}

/**
 * Split text into `MAX_TEXT`-or-shorter pieces, preferring word boundaries.
 * A chunk break at a space consumes that space (the caller rejoins with " ").
 */
function chunk(text: string): string[] {
  if (text.length <= MAX_TEXT) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > MAX_TEXT) {
    const window = rest.slice(0, MAX_TEXT + 1);
    const space = window.lastIndexOf(" ");
    // No space to break on (one giant token): hard-split at the limit.
    const cut = space > 0 ? space : MAX_TEXT;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(space > 0 ? cut + 1 : cut);
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

/** Split a block list into request-sized batches. */
export function batches(blocks: NotionBlock[]): NotionBlock[][] {
  const out: NotionBlock[][] = [];
  for (let i = 0; i < blocks.length; i += MAX_CHILDREN) {
    out.push(blocks.slice(i, i + MAX_CHILDREN));
  }
  return out;
}
