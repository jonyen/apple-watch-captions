import { loadConfig } from "./config";
import { chooseSummarizer } from "./chooseSummarizer";
import { createNotionSummaryPatcher } from "./notionExporter";
import { backfillSummaries } from "./summaryBackfill";
import { listTranscripts } from "./transcriptStore";

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

  const total = listTranscripts(config.transcriptsDir).length;
  const willDo = Math.min(last, total);
  console.log(`Regenerating the newest ${willDo} of ${total} stored summaries. Each is a paid model call.`);

  const result = await backfillSummaries({
    dir: config.transcriptsDir,
    summarize,
    force: true,
    limit: last,
    patchPage: config.notion ? createNotionSummaryPatcher(config.notion) : undefined,
  });

  console.log(
    `Done: ${result.summarized} regenerated, ${result.patched} updated in Notion, ${result.failed} failed, ${result.skipped} skipped.`,
  );
}

// Only run when invoked directly, so importing parseArgs in tests is free.
if (process.argv[1]?.endsWith("resummarize.ts")) {
  main().catch((err) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  });
}
