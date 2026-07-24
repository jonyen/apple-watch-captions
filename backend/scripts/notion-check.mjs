#!/usr/bin/env node
// Verifies a Notion integration before deploying: token works, the database is
// reachable, and the columns the exporter fills are present.
//
//   node scripts/notion-check.mjs <token> <database-id>
//   NOTION_TOKEN=… NOTION_DATABASE_ID=… node scripts/notion-check.mjs
//
// The most common failure is a valid token that has not been given access to
// the database — that shows up as a 404, not a 401.

const token = process.argv[2] || process.env.NOTION_TOKEN;
const databaseId = process.argv[3] || process.env.NOTION_DATABASE_ID;

if (!token || !databaseId) {
  console.error("usage: node scripts/notion-check.mjs <token> <database-id>");
  process.exit(2);
}

const response = await fetch(`https://api.notion.com/v1/databases/${databaseId}`, {
  headers: {
    Authorization: `Bearer ${token}`,
    "Notion-Version": "2022-06-28",
  },
});
const body = await response.json().catch(() => ({}));

if (!response.ok) {
  console.error(`✗ ${response.status} ${body.code ?? ""}: ${body.message ?? "unknown error"}`);
  if (response.status === 404) {
    console.error(
      "\n  A 404 usually means the database exists but is not shared with the\n" +
        "  integration. In Notion: open the database → ⋯ → Connections → add\n" +
        "  your integration. Also check the id is the database's, not a page's.",
    );
  }
  process.exit(1);
}

const properties = body.properties ?? {};
const entries = Object.entries(properties).map(([name, p]) => [name, p.type]);
const title = entries.find(([, type]) => type === "title");

console.log(`✓ reachable: ${(body.title ?? []).map((t) => t.plain_text).join("") || databaseId}`);

if (!title) {
  console.error("✗ no title property — the exporter cannot name pages");
  process.exit(1);
}
console.log(`✓ title property: "${title[0]}"`);

// Optional columns; the exporter fills whichever exist with a matching type.
const optional = { Started: "date", Ended: "date", Segments: "number", Session: "rich_text" };
for (const [name, type] of Object.entries(optional)) {
  const actual = properties[name]?.type;
  if (name === title[0]) continue;
  if (actual === type) console.log(`✓ ${name} (${type})`);
  else if (actual) console.log(`- ${name} is ${actual}, expected ${type} — will be skipped`);
  else console.log(`- ${name} not defined — will be skipped (add a ${type} column to fill it)`);
}
