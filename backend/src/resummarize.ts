import { loadConfig } from "./config";
import { chooseSummarizer } from "./chooseSummarizer";
import { userDirs } from "./userDirs";
import { backfillSummaries } from "./summaryBackfill";
import { openDb } from "./db";
import { buildDestinations, buildResolveExporters } from "./serverOptions";

const USAGE = "usage: npm run resummarize -- --last <N>   (use --last 9999 for the whole archive)";

/**
 * `--last` is required on purpose. Regenerating the entire archive is a real
 * thing to want, but it should be spelled `--last 9999` deliberately rather
 * than reached by forgetting a flag.
 */
export function parseArgs(argv: string[]): { last: number } {
  let raw: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--last") raw = argv[i + 1];
    else if (arg.startsWith("--last=")) raw = arg.slice("--last=".length);
  }
  if (raw === undefined) throw new Error(`--last is required. ${USAGE}`);
  const last = Number(raw);
  if (!Number.isInteger(last) || last <= 0) {
    throw new Error(`--last must be a positive integer, got "${raw}". ${USAGE}`);
  }
  return { last };
}

async function main(): Promise<void> {
  const { last } = parseArgs(process.argv.slice(2));
  const config = loadConfig(process.env);

  const summarize = chooseSummarizer(config);
  if (!summarize) throw new Error("no summarizer configured: set ANTHROPIC_API_KEY or GEMINI_API_KEY");

  // `--last` is per user, not global: each user's newest N are regenerated,
  // so one busy account cannot consume another's budget.
  const dirs = userDirs(config.transcriptsDir);
  console.log(`Regenerating the newest ${last} summaries for each of ${dirs.length} user(s). Each is a paid model call.`);

  // Without `resolve`, a regenerated summary is written to disk and never
  // reaches the Notion page it belongs to — silently, since the parameter is
  // optional. Built the same way `buildServerOptions` does.
  const db = openDb(config.dbPath);
  const destinations = buildDestinations(config, db);
  const resolve = buildResolveExporters(destinations);

  const totals = { summarized: 0, patched: 0, failed: 0, skipped: 0 };
  for (const { dir, userId } of dirs) {
    const r = await backfillSummaries({ dir, userId, summarize, resolve, force: true, limit: last });
    totals.summarized += r.summarized;
    totals.patched += r.patched;
    totals.failed += r.failed;
    totals.skipped += r.skipped;
  }

  console.log(
    `Done: ${totals.summarized} regenerated, ${totals.patched} updated in Notion, ${totals.failed} failed, ${totals.skipped} skipped.`,
  );
}

// Only run when invoked directly, so importing parseArgs in tests is free.
if (process.argv[1]?.endsWith("resummarize.ts")) {
  main().catch((err) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  });
}
