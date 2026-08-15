# Multi-Tenant Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry the four features the production relay has — and the multi-tenant base lacks — onto that base, so the migration can deploy without regressing anything.

**Architecture:** Backend only. The multi-tenant relay stores transcripts under `userDir(root, userId)` and sweeps once per user directory. The port adapts single-tenant code to that shape: two private helpers in `index.ts` become shared modules so a CLI can use them without booting the relay, and the summary backfill regains `force` and an attempt-bounded limit.

**Tech Stack:** Node/TypeScript, vitest, tsx. Deployed on Fly.io.

**Spec:** `docs/superpowers/specs/2026-08-15-multi-tenant-migration-design.md`

## Global Constraints

- **Backend only.** Every change is under `backend/`. Do not touch `watch/`, `ios/`, `mac/`, or `CaptionCore` — a separate session is extracting those concurrently, and the spec's "Division of work" section makes this the parallel-safe half.
- **Do not deploy.** This plan produces a branch. The cutover is section 2 of the spec and needs client builds that do not exist yet.
- **Cross-tenant isolation must not regress.** It is the property the multi-tenant suites exist to protect. Anything reading or writing transcripts takes a `userId`.
- **The source of truth for ported code is `git show main:backend/src/<file>`** — the local lineage preserved as `backup/local-main-2026-08-15`. Copy from git rather than retyping.
- Node's `--omit=dev` production install carries `tsx`; dev-only imports must not leak into runtime paths.

## File Structure

| File | Responsibility |
|---|---|
| `backend/src/summaryPrompt.ts` | Modify — the expansive prompt replaces the short one |
| `backend/src/chooseSummarizer.ts` | Create — the provider selection currently inline in `index.ts` |
| `backend/src/userDirs.ts` | Create — the per-user directory lister currently private in `index.ts` |
| `backend/src/index.ts` | Modify — import both instead of defining them |
| `backend/src/summaryBackfill.ts` | Modify — add `force`, make `limit` bound attempts |
| `backend/src/resummarize.ts` | Create — the regeneration CLI, iterating user directories |
| `docs/superpowers/specs/2026-08-15-multi-tenant-migration-design.md` | Modify — record the spike's answer (Task 1 only) |

---

### Task 1: Spike — does two-way call audio need user scoping?

The spec names this the only piece that can turn a day into a week, and says to settle it before scheduling. **This task writes no production code.** Its deliverable is a written answer.

**Files:**
- Modify: `docs/superpowers/specs/2026-08-15-multi-tenant-migration-design.md`

**Interfaces:**
- Consumes: nothing.
- Produces: a finding that sizes Task 6. No code other tasks import.

- [ ] **Step 1: Read what the port would move**

The five files exist only on the local lineage:

```bash
cd /Users/jonyen/Projects/apple-watch-captions
for f in callUplink callAudioBuffer callPresence mulaw ringback; do
  echo "=== $f ==="; git show main:backend/src/$f.ts | head -40
done
```

- [ ] **Step 2: Read what they would land on**

The multi-tenant base already has `currentCall.ts`, `twilioFrames.ts`, and `twilioStreamHandler.ts`. Read all three, plus how `server.call.test.ts` exercises them.

- [ ] **Step 3: Answer three questions in writing**

1. Does any of the five files persist anything, or hold state keyed by something that must now be per user? Call sessions are ephemeral by design — no transcript, no summary, no export — so the expected answer is no.
2. Does `callPresence` track "a watch is here to receive a call" globally? On a multi-user relay, one user's presence must not route another user's call. **This is the question most likely to be yes.**
3. Do the call HTTP routes authenticate? On the base every route takes a bearer token; the Twilio webhook cannot, since Twilio supplies no token.

- [ ] **Step 4: Record the answer in the spec**

Replace section 1's item 4 with what you found, and state plainly whether Task 6 is mechanical or structural. If structural, say what the smallest correct scoping would be — do not design it here.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-08-15-multi-tenant-migration-design.md
git commit -m "docs: size the two-way call audio port"
```

---

### Task 2: The expansive summary prompt

**Files:**
- Modify: `backend/src/summaryPrompt.ts`
- Test: `backend/src/summaryPrompt.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SUMMARY_SYSTEM_PROMPT` asking for topic sections. Same export name and type; every caller is unchanged.

- [ ] **Step 1: Write the failing test**

Add to `backend/src/summaryPrompt.test.ts`, inside the existing describe block:

```ts
  it("asks for one section per topic rather than a flat bullet list", () => {
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/one section per topic/);
  });

  it("tells the model to cover the whole recording, not just the opening", () => {
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/middle and end/);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run src/summaryPrompt.test.ts`
Expected: FAIL — the current prompt says "concise markdown summary… key points as bullets" and contains neither phrase.

- [ ] **Step 3: Replace the prompt**

Copy the expansive version verbatim rather than retyping it:

```bash
cd /Users/jonyen/Projects/apple-watch-captions
git show main:backend/src/summaryPrompt.ts > /tmp/expansive-prompt.ts
```

Take **only** the `SUMMARY_SYSTEM_PROMPT` declaration from that file and replace the one in `backend/src/summaryPrompt.ts`. Leave everything else in the current file alone — `formatTranscript`, `summaryPrompt`, `parseSummary`, and `MAX_TITLE` are unchanged by this port, and the multi-tenant file may have diverged elsewhere.

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx vitest run src/summaryPrompt.test.ts`
Expected: PASS, including the pre-existing `Title:` test.

- [ ] **Step 5: Run the full suite**

Run: `cd backend && npm test`
Expected: all passing. A summarizer test asserting the old prompt's wording would fail here — fix the test, not the prompt.

- [ ] **Step 6: Commit**

```bash
git add backend/src/summaryPrompt.ts backend/src/summaryPrompt.test.ts
git commit -m "feat(summary): ask for topic sections scaled to the recording"
```

---

### Task 3: Extract the two helpers `index.ts` keeps private

Pure refactor, no behavior change. It exists because Task 5's CLI needs both, and importing them from `index.ts` would start the relay as a side effect.

**Files:**
- Create: `backend/src/chooseSummarizer.ts`
- Create: `backend/src/userDirs.ts`
- Modify: `backend/src/index.ts`

**Interfaces:**
- Consumes: `Config` from `./config`, `Summarize` from `./summarizer`.
- Produces:
  - `export function chooseSummarizer(config: Config): Summarize | undefined`
  - `export function userDirs(root: string): { dir: string; userId: string }[]`

- [ ] **Step 1: Create `chooseSummarizer.ts`**

Move the function from `index.ts` verbatim, adding `config` as a parameter since it can no longer close over the module-level one:

```ts
import { Config } from "./config";
import { Summarize, createClaudeSummarizer } from "./summarizer";
import { createGeminiSummarizer } from "./geminiSummarizer";

/**
 * Pick the summarizer backend: an explicit SUMMARY_PROVIDER wins, otherwise
 * whichever key is configured (Claude first, since it is the better model).
 *
 * Extracted from index.ts so the resummarize entrypoint shares the same
 * selection rather than reimplementing it — importing it from index.ts would
 * start the relay as a side effect.
 */
export function chooseSummarizer(config: Config): Summarize | undefined {
  const wanted =
    config.summaryProvider ??
    (config.anthropicApiKey ? "claude" : config.geminiApiKey ? "gemini" : undefined);

  if (wanted === "claude") {
    if (config.anthropicApiKey) return createClaudeSummarizer(config.anthropicApiKey);
    console.warn("SUMMARY_PROVIDER=claude but ANTHROPIC_API_KEY is not set");
  } else if (wanted === "gemini") {
    if (config.geminiApiKey) return createGeminiSummarizer(config.geminiApiKey);
    console.warn("SUMMARY_PROVIDER=gemini but GEMINI_API_KEY is not set");
  }
  return undefined;
}
```

- [ ] **Step 2: Create `userDirs.ts`**

Move it from `index.ts` verbatim, keeping its comments — they explain why the directory name is the user id:

```ts
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The per-user subdirectories under the transcripts root — each backfill
 * sweep runs once per user rather than once over the (now-empty, once
 * migration has run) flat root, since transcripts live under
 * `userDir(root, userId)` rather than directly in `root`.
 */
export function userDirs(root: string): { dir: string; userId: string }[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((entry) => statSync(join(root, entry)).isDirectory())
    // The directory name *is* the user id — `userDir` joins it verbatim — so
    // the sweeps below can attribute what they rebuild instead of handing
    // downstream an ownerless transcript.
    .map((entry) => ({ dir: join(root, entry), userId: entry }));
}
```

- [ ] **Step 3: Rewire `index.ts`**

Delete both function bodies from `index.ts` and import them instead:

```ts
import { chooseSummarizer } from "./chooseSummarizer";
import { userDirs } from "./userDirs";
```

Change the one call site from `chooseSummarizer()` to `chooseSummarizer(config)`. Leave the `console.log` that reports the chosen provider exactly as it is.

Remove any `node:fs` / `node:path` imports in `index.ts` that only `userDirs` used — and only those. Check each remaining usage before deleting an import.

- [ ] **Step 4: Verify nothing changed**

Run: `cd backend && npm test && npm run build`
Expected: all tests passing and `tsc --noEmit` clean. This is a refactor; a behavioral test failing here means the move was not verbatim.

- [ ] **Step 5: Commit**

```bash
git add backend/src/chooseSummarizer.ts backend/src/userDirs.ts backend/src/index.ts
git commit -m "refactor(relay): share the summarizer chooser and user-dir lister"
```

---

### Task 4: `force` and an attempt-bounded limit in the backfill

**Files:**
- Modify: `backend/src/summaryBackfill.ts`
- Test: `backend/src/summaryBackfill.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `SummaryBackfillOptions` gains `force?: boolean`. `limit` now bounds model calls attempted, not summaries succeeded.

- [ ] **Step 1: Write the failing tests**

Add to `backend/src/summaryBackfill.test.ts`. Follow the existing suite's fixture style — read it first and reuse its helpers rather than inventing new ones:

The suite already provides `storeSession(root, id, at)`, `summarizer()`, `scoped(root)`, and the fixed user `U`. Reuse them; do not invent new fixtures.

```ts
  it("re-summarizes an already-summarized transcript under force", async () => {
    const name = storeSession(root, "s1", 1000);
    writeSummary(scoped(root), name, "an existing summary");
    const summarize = summarizer();

    const result = await backfillSummaries({
      dir: scoped(root),
      userId: U,
      summarize,
      force: true,
      delayMs: 0,
    });

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(result.summarized).toBe(1);
  });

  it("leaves an already-summarized transcript alone without force", async () => {
    const name = storeSession(root, "s1", 1000);
    writeSummary(scoped(root), name, "an existing summary");
    const summarize = summarizer();

    const result = await backfillSummaries({
      dir: scoped(root),
      userId: U,
      summarize,
      delayMs: 0,
    });

    expect(summarize).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it("counts a failed model call against the limit", async () => {
    storeSession(root, "s1", 1000);
    storeSession(root, "s2", 2000);
    const summarize = vi.fn(async () => {
      throw new Error("token ceiling");
    });

    const result = await backfillSummaries({
      dir: scoped(root),
      userId: U,
      summarize,
      limit: 1,
      delayMs: 0,
    });

    // A limit bounding successes would keep walking the archive looking for
    // a success that never comes, spending a paid call on every transcript.
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(result.failed).toBe(1);
  });
```

If the suite already covers the second case, keep its version and drop this one rather than asserting the same thing twice. Check the `root` fixture's name in the existing `beforeEach` and match it.

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && npx vitest run src/summaryBackfill.test.ts`
Expected: FAIL — `force` is not in the options type, and `limit` currently gates on `result.summarized`.

- [ ] **Step 3: Implement**

In `SummaryBackfillOptions`, add:

```ts
  /**
   * Re-summarize transcripts that already have a summary. Off by default: the
   * summary file is the done-marker, and the boot-time sweep must stay cheap.
   */
  force?: boolean;
```

In the loop, replace the limit check and the has-summary skip:

```ts
  // Counts model calls actually made (success or failure), not just
  // successes — `limit` bounds paid calls, so a run of systematic failures
  // (e.g. every transcript exceeding the token ceiling) must not keep
  // walking the archive looking for `limit` successes that never come.
  let attempts = 0;

  for (const listed of listTranscripts(opts.dir).reverse()) {
    if (opts.limit !== undefined && attempts >= opts.limit) break;
    if (listed.hasSummary && !opts.force) {
      result.skipped++;
      continue;
    }
```

and increment `attempts` immediately before the `opts.summarize(transcript)` call, after the `isSubstantial` check — so a skipped short transcript does not consume a paid call it never made.

- [ ] **Step 4: Run to verify they pass**

Run: `cd backend && npm test`
Expected: all passing, including the boot-sweep tests that call `backfillSummaries` without `force`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/summaryBackfill.ts backend/src/summaryBackfill.test.ts
git commit -m "feat(summary): add force mode and bound backfill by attempts"
```

---

### Task 5: The `resummarize` CLI

**Files:**
- Create: `backend/src/resummarize.ts`
- Test: `backend/src/resummarize.test.ts`
- Modify: `backend/package.json`

**Interfaces:**
- Consumes: `chooseSummarizer` and `userDirs` (Task 3), `force` and attempt-bounded `limit` (Task 4).
- Produces: `export function parseArgs(argv: string[]): { last: number }` and an `npm run resummarize` script.

- [ ] **Step 1: Write the failing test**

Create `backend/src/resummarize.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseArgs } from "./resummarize";

describe("parseArgs", () => {
  it("reads --last N", () => {
    expect(parseArgs(["--last", "20"])).toEqual({ last: 20 });
  });

  it("accepts --last=N", () => {
    expect(parseArgs(["--last=5"])).toEqual({ last: 5 });
  });

  it("refuses to run without --last rather than defaulting to everything", () => {
    expect(() => parseArgs([])).toThrow(/--last is required/);
  });

  it("rejects a non-positive count", () => {
    expect(() => parseArgs(["--last", "0"])).toThrow(/positive integer/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx vitest run src/resummarize.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the CLI**

```ts
import { loadConfig } from "./config";
import { chooseSummarizer } from "./chooseSummarizer";
import { userDirs } from "./userDirs";
import { backfillSummaries } from "./summaryBackfill";
import { openDb } from "./db";
import { ExportDestinationStore } from "./exportDestinations";
import { keyFromEnv } from "./secretBox";
import { buildResolveExporters } from "./serverOptions";

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
  const destinations = config.encryptionKey
    ? new ExportDestinationStore(db, keyFromEnv(config.encryptionKey))
    : undefined;
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
```

**Why the resolver is built here.** `resolve` is *optional* on `SummaryBackfillOptions`, so omitting it compiles and runs — and silently writes regenerated summaries to disk that never reach their Notion pages. `buildResolveExporters` lives in `serverOptions.ts`, not `index.ts`, so importing it does not boot the relay. Verify that: if importing `serverOptions.ts` has module-level side effects, stop and report rather than dropping the parameter.

- [ ] **Step 4: Add the npm script**

In `backend/package.json`, alongside the existing scripts:

```json
    "resummarize": "tsx src/resummarize.ts"
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd backend && npm test && npm run build`
Expected: all passing, `tsc --noEmit` clean.

- [ ] **Step 6: Commit**

```bash
git add backend/src/resummarize.ts backend/src/resummarize.test.ts backend/package.json
git commit -m "feat(summary): add resummarize CLI for regenerating the newest N"
```

---

### Task 6: Port two-way call audio

**Sized by Task 1.** If that spike found the port mechanical, this is one task. If it found call presence must become per-user, **stop and split this into its own plan** rather than absorbing structural work here.

**Files:**
- Create: `backend/src/mulaw.ts`, `backend/src/ringback.ts`, `backend/src/callAudioBuffer.ts`, `backend/src/callPresence.ts`, `backend/src/callUplink.ts` (and their tests)
- Modify: `backend/src/index.ts`, `backend/src/twilioStreamHandler.ts`, `backend/src/twiml.ts`

**Interfaces:**
- Consumes: the spike's finding.
- Produces: the `/v1/call/audio` uplink and downlink routes the watch's **Tune in** action depends on.

- [ ] **Step 1: Re-read the spike's finding**

Read the amended section 1 item 4 of the spec. Do not start until it says mechanical.

- [ ] **Step 2: Copy the leaf modules and their tests**

```bash
cd /Users/jonyen/Projects/apple-watch-captions
for f in mulaw ringback callAudioBuffer callPresence callUplink; do
  git show main:backend/src/$f.ts > backend/src/$f.ts
  git show main:backend/src/$f.test.ts > backend/src/$f.test.ts 2>/dev/null || true
done
```

Then run `cd backend && npm test` and fix what fails. Expect failures where these modules import something the base names differently — that is the port, and each one is a decision to record in the commit message.

- [ ] **Step 3: Wire the routes**

Compare `git show main:backend/src/index.ts` against the current one for the call routes only, and add them. Every route on this base authenticates with a bearer token; the Twilio webhook is the documented exception. Follow whatever the base already does for `/twilio/voice`.

- [ ] **Step 4: Run the full suite**

Run: `cd backend && npm test && npm run build`
Expected: all passing, `tsc --noEmit` clean, and the pre-existing `server.call.test.ts` still green — it covers the inbound captioning half this port must not disturb.

- [ ] **Step 5: Commit**

```bash
git add backend/src
git commit -m "feat(relay): port two-way call audio onto the multi-tenant base"
```
