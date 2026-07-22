/**
 * Backfill CLI: pushes every stored transcript that hasn't been synced yet
 * to Notion. New transcripts sync automatically on session end; run this
 * once to bring pre-existing transcripts over, or to catch up after an outage.
 *
 *   NOTION_API_KEY=... NOTION_DATABASE_ID=... npm run sync:notion
 */
import { listTranscripts, readTranscript, FinalizedTranscript } from "./transcriptStore";
import { createNotionSync, notionPageIdFor, recordNotionPage } from "./notionSync";

const apiKey = process.env.NOTION_API_KEY;
const databaseId = process.env.NOTION_DATABASE_ID;
if (!apiKey || !databaseId) {
  console.error("NOTION_API_KEY and NOTION_DATABASE_ID are required");
  process.exit(1);
}
const dir = process.env.TRANSCRIPTS_DIR || "./data/transcripts";

const sync = createNotionSync({ apiKey, databaseId });
const all = listTranscripts(dir).reverse(); // oldest first, so Notion sorts naturally
console.log(`${all.length} transcript(s) in ${dir}`);

let synced = 0;
let skipped = 0;
for (const { name } of all) {
  if (notionPageIdFor(dir, name)) {
    skipped++;
    continue;
  }
  const detail = readTranscript(dir, name);
  if (!detail || detail.segments.length === 0) {
    skipped++;
    continue;
  }
  const t: FinalizedTranscript = {
    name,
    sessionId: name.split("_")[1] ?? "session",
    startedAt: detail.segments[0].at,
    endedAt: detail.segments[detail.segments.length - 1].at,
    segments: detail.segments,
  };
  try {
    const pageId = await sync(t, detail.summary);
    recordNotionPage(dir, name, pageId);
    synced++;
    console.log(`synced ${name} → page ${pageId}`);
  } catch (err) {
    console.error(`sync failed for ${name}:`, err);
  }
}
console.log(`done: ${synced} synced, ${skipped} skipped (already synced or empty)`);
