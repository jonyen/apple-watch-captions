# Expansive Summaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make transcript summaries expansive — topic sections that scale with recording length, preserving specifics — and regenerate the newest N stored summaries under the new prompt.

**Architecture:** One shared system prompt (`summaryPrompt.ts`) drives both the Claude and Gemini summarizers, so the prompt rewrite is a single edit. The 2048-token ceiling that thinking and response text currently share is raised to 16000, and truncation becomes a thrown error instead of a silently-stored partial. The watch parses the resulting markdown instead of rendering it literally. Regeneration is a `force` flag on the existing backfill plus a standalone CLI entrypoint, deliberately kept off the server boot path.

**Tech Stack:** TypeScript + Node (backend, vitest), Swift + SwiftUI (watchOS), Anthropic SDK, Gemini REST, Notion REST.

## Global Constraints

- Branch: `feat/expansive-summaries`. Spec: `docs/superpowers/specs/2026-08-11-expansive-summaries-design.md`.
- Backend commands run from `backend/`: `npm test` (vitest), `npm run build` (`tsc --noEmit`).
- The `Title: <text>` first-line contract is **unchanged**. `parseSummary` depends on it; do not alter its parsing.
- `max_tokens` / `max_output_tokens` value is **16000** on both providers.
- Model IDs stay as they are — `claude-opus-4-8` and `gemini-3.6-flash`. Model migration is explicitly out of scope.
- `force` defaults to `false` everywhere, so `runBackfills()` behavior is unchanged.
- Never add regeneration to `runBackfills()` in `src/index.ts`. It runs on every server boot.

---

### Task 1: Rewrite the shared summary prompt

**Files:**
- Modify: `backend/src/summaryPrompt.ts:4-15`
- Test: `backend/src/summaryPrompt.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `SUMMARY_SYSTEM_PROMPT: string` — unchanged export name and type. Both `summarizer.ts` and `geminiSummarizer.ts` already import it.

- [ ] **Step 1: Write the failing test**

Append to `backend/src/summaryPrompt.test.ts`:

```ts
describe("SUMMARY_SYSTEM_PROMPT", () => {
  it("keeps the Title contract parseSummary depends on", () => {
    expect(SUMMARY_SYSTEM_PROMPT).toContain("Title:");
  });

  it("asks for topic sections that scale with the recording", () => {
    expect(SUMMARY_SYSTEM_PROMPT).toContain("## ");
    expect(SUMMARY_SYSTEM_PROMPT.toLowerCase()).toContain("one section per topic");
  });

  it("asks for the whole recording, not just the opening", () => {
    expect(SUMMARY_SYSTEM_PROMPT.toLowerCase()).toContain("every part of the recording");
  });

  it("asks for specifics to be preserved rather than compressed away", () => {
    expect(SUMMARY_SYSTEM_PROMPT.toLowerCase()).toContain("names, numbers, dates");
  });

  it("no longer asks for a concise summary", () => {
    expect(SUMMARY_SYSTEM_PROMPT.toLowerCase()).not.toContain("concise");
  });
});
```

Ensure the import at the top of the file includes `SUMMARY_SYSTEM_PROMPT`:

```ts
import { SUMMARY_SYSTEM_PROMPT, parseSummary, formatTranscript, summaryPrompt } from "./summaryPrompt";
```

(Keep whichever names the file already imports; add `SUMMARY_SYSTEM_PROMPT` to the list.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx vitest run src/summaryPrompt.test.ts`
Expected: FAIL — the current prompt contains "concise" and none of the new phrases.

- [ ] **Step 3: Replace the prompt**

In `backend/src/summaryPrompt.ts`, replace the whole `SUMMARY_SYSTEM_PROMPT` assignment with:

```ts
export const SUMMARY_SYSTEM_PROMPT =
  "You summarize transcripts captured by a live-captioning watch app. " +
  "Begin your reply with a single line of the form 'Title: <short title>' — " +
  "at most 10 words naming what the recording is about, with no trailing " +
  "punctuation. Then a blank line, then the summary itself.\n\n" +
  "Write the summary in markdown, in this shape:\n" +
  "1. An opening paragraph giving an overview of the whole recording.\n" +
  "2. Then one section per topic discussed, each introduced by a '## ' heading " +
  "naming that topic, followed by prose covering what was said about it.\n" +
  "3. If action items or decisions are mentioned, a final '## Action items' " +
  "section listing them as bullets.\n\n" +
  "Let the number of sections follow the recording: a short exchange may need " +
  "one, a long meeting may need many. Cover every part of the recording, " +
  "including the middle and end — do not let coverage thin out after the " +
  "opening. Preserve specifics rather than compressing them away: names, " +
  "numbers, dates, decisions, and commitments should survive into the summary. " +
  "Do not invent details that are not in the transcript.\n\n" +
  "The transcript is one side or a mix of a real-world conversation and may " +
  "contain transcription errors. Lines prefixed 'Me:' were spoken by the user; " +
  "lines prefixed 'Them:' are the other party or audio playing on their device.";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx vitest run src/summaryPrompt.test.ts`
Expected: PASS — including every pre-existing `parseSummary` test, which must be untouched.

- [ ] **Step 5: Commit**

```bash
cd backend && npm run build
git add src/summaryPrompt.ts src/summaryPrompt.test.ts
git commit -m "feat(summary): ask for topic sections scaled to the recording"
```

---

### Task 2: Raise the Claude ceiling and fail on truncation

**Files:**
- Modify: `backend/src/summarizer.ts:8-21`
- Test: `backend/src/summarizer.test.ts` (create)

**Interfaces:**
- Consumes: `SUMMARY_SYSTEM_PROMPT` from Task 1.
- Produces: `createClaudeSummarizer(apiKey: string, opts?: { client?: MessageCreator }): Summarize`, where `MessageCreator` is `{ messages: { create: (body: unknown) => Promise<ClaudeResponse> } }`. The new optional `opts.client` exists solely so tests can inject a fake; production callers in `src/index.ts` keep calling `createClaudeSummarizer(apiKey)` with one argument.

- [ ] **Step 1: Write the failing test**

Create `backend/src/summarizer.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createClaudeSummarizer } from "./summarizer";
import { FinalizedTranscript } from "./transcriptStore";

const transcript: FinalizedTranscript = {
  name: "2026-08-11_sess",
  startedAt: "2026-08-11T00:00:00.000Z",
  endedAt: "2026-08-11T00:05:00.000Z",
  segments: [{ text: "hello there", channel: 0 }],
} as FinalizedTranscript;

function fakeClient(response: unknown) {
  return { messages: { create: async () => response } };
}

describe("createClaudeSummarizer", () => {
  it("returns the text of a complete response", async () => {
    const summarize = createClaudeSummarizer("key", {
      client: fakeClient({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Title: A chat\n\nAn overview." }],
      }),
    });
    await expect(summarize(transcript)).resolves.toContain("Title: A chat");
  });

  it("throws when the response was truncated at the token ceiling", async () => {
    const summarize = createClaudeSummarizer("key", {
      client: fakeClient({
        stop_reason: "max_tokens",
        content: [{ type: "text", text: "Title: A chat\n\nAn overview that stops mid-" }],
      }),
    });
    await expect(summarize(transcript)).rejects.toThrow(/truncated/i);
  });

  it("throws rather than returning empty when no text block came back", async () => {
    const summarize = createClaudeSummarizer("key", {
      client: fakeClient({ stop_reason: "end_turn", content: [] }),
    });
    await expect(summarize(transcript)).rejects.toThrow(/no summary text/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx vitest run src/summarizer.test.ts`
Expected: FAIL — `createClaudeSummarizer` takes only one argument today, so `opts.client` is ignored and it tries a real network call.

- [ ] **Step 3: Rewrite the summarizer**

Replace the body of `backend/src/summarizer.ts` below the imports with:

```ts
export type Summarize = (transcript: FinalizedTranscript) => Promise<string>;

/** The slice of the Anthropic client this module uses, so tests can inject a fake. */
export interface MessageCreator {
  messages: { create: (body: any) => Promise<any> };
}

export interface ClaudeSummarizerOptions {
  /** Injectable for tests. */
  client?: MessageCreator;
}

/**
 * Claude-backed summarizer.
 *
 * `max_tokens` bounds thinking *and* response text together, so it has to be
 * generous enough for an expansive summary plus the model's own reasoning.
 * 16000 keeps the request under the SDK's non-streaming HTTP timeout; going
 * higher would mean converting this call to a stream.
 */
export function createClaudeSummarizer(
  apiKey: string,
  opts: ClaudeSummarizerOptions = {},
): Summarize {
  const client = opts.client ?? new Anthropic({ apiKey });
  return async (t) => {
    const response = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: SUMMARY_SYSTEM_PROMPT,
      messages: [{ role: "user", content: summaryPrompt(t) }],
    });

    // A truncated summary must not be stored: the summary file is the
    // done-marker, so a partial would never be revisited. Throwing leaves the
    // transcript unsummarized and therefore retryable on the next sweep.
    if (response.stop_reason === "max_tokens") {
      throw new Error(`Claude summary truncated at the token ceiling for ${t.name}`);
    }

    const block = response.content.find((b: any) => b.type === "text");
    const text = block?.type === "text" ? block.text : "";
    if (text.trim().length === 0) {
      throw new Error(`Claude returned no summary text for ${t.name}`);
    }
    return text;
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx vitest run src/summarizer.test.ts`
Expected: PASS — all three.

- [ ] **Step 5: Commit**

```bash
cd backend && npm run build && npm test
git add src/summarizer.ts src/summarizer.test.ts
git commit -m "feat(summary): raise the Claude ceiling to 16k and fail on truncation"
```

---

### Task 3: Cap Gemini output to match

**Files:**
- Modify: `backend/src/geminiSummarizer.ts:37-46`
- Test: `backend/src/geminiSummarizer.test.ts`

**Interfaces:**
- Consumes: `SUMMARY_SYSTEM_PROMPT` from Task 1.
- Produces: no signature change. `createGeminiSummarizer(apiKey, opts)` keeps its existing shape; only the request body gains a field.

- [ ] **Step 1: Write the failing test**

Append to `backend/src/geminiSummarizer.test.ts`:

```ts
it("caps output tokens so both providers agree on length", async () => {
  let sentBody: any;
  const summarize = createGeminiSummarizer("key", {
    fetch: async (_url, init) => {
      sentBody = JSON.parse(String((init as any).body));
      return new Response(JSON.stringify({ output_text: "Title: X\n\nBody." }), { status: 200 });
    },
  });
  await summarize(transcript);
  expect(sentBody.generation_config.max_output_tokens).toBe(16000);
  // The existing thinking_level must survive the edit.
  expect(sentBody.generation_config.thinking_level).toBe("low");
});
```

Reuse whatever `transcript` fixture the file already defines. If it defines none, add the same fixture used in Task 1's test file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx vitest run src/geminiSummarizer.test.ts`
Expected: FAIL — `max_output_tokens` is `undefined`.

- [ ] **Step 3: Add the cap**

In `backend/src/geminiSummarizer.ts`, change the `generation_config` line to:

```ts
        // Summarizing is not a reasoning-heavy task, and the free tier is
        // capped on daily tokens — thinking defaults high enough to dominate
        // the bill (69 thought tokens for a 2-token reply, measured).
        // The output cap matches the Claude path so the two providers produce
        // comparable lengths from the same prompt.
        generation_config: { thinking_level: "low", max_output_tokens: 16000 },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx vitest run src/geminiSummarizer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd backend && npm run build
git add src/geminiSummarizer.ts src/geminiSummarizer.test.ts
git commit -m "feat(summary): cap Gemini output to match the Claude ceiling"
```

---

### Task 4: Make the Notion summary patcher replace instead of append

**Files:**
- Modify: `backend/src/notionUpdater.ts:16-17,93-110` (move `findToggles` and the toggle constants out)
- Modify: `backend/src/notionExporter.ts:69-82` (import the moved helper; patcher deletes before appending)
- Test: `backend/src/notionExporter.test.ts` (create if absent)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `notionExporter.ts` now exports `SUMMARY_TOGGLE: string`, `TRANSCRIPT_TOGGLE: string`, and `findToggles(request: Request, pageId: string): Promise<{ summary?: string; transcript?: string }>`. `notionUpdater.ts` imports all three from `notionExporter` instead of defining them. `createNotionSummaryPatcher` keeps its existing signature: `(opts: NotionExporterOptions) => (pageId: string, summary: string) => Promise<void>`.

**Why this task exists:** `backfillSummaries` patches Notion through `createNotionSummaryPatcher`, which calls `appendToggle`. Today that is safe because the patcher only sees pages with no summary. Under Task 6's `force` mode it would append a *second* "Summary" toggle. `notionUpdater` already solves this, but its `findToggles` is private and `notionUpdater` imports from `notionExporter` — so the helper moves down, not up, to keep imports one-way.

- [ ] **Step 1: Write the failing test**

Create `backend/src/notionExporter.test.ts` (or append if it exists):

```ts
import { describe, expect, it, vi } from "vitest";
import { createNotionSummaryPatcher } from "./notionExporter";

/** Build a patcher whose HTTP layer is a spy over a canned page listing. */
function patcherOver(children: unknown[]) {
  const calls: Array<{ path: string; method: string }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const path = url.replace("https://api.notion.com/v1", "");
    calls.push({ path, method: init?.method ?? "GET" });
    if (path.includes("/children") && (init?.method ?? "GET") === "GET") {
      return new Response(JSON.stringify({ results: children }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };
  const patch = createNotionSummaryPatcher({
    token: "t",
    databaseId: "d",
    fetch: fetchImpl,
  } as any);
  return { patch, calls };
}

const summaryToggle = {
  id: "blk_old",
  type: "toggle",
  toggle: { rich_text: [{ plain_text: "Summary" }] },
};

describe("createNotionSummaryPatcher", () => {
  it("deletes an existing Summary toggle before appending the new one", async () => {
    const { patch, calls } = patcherOver([summaryToggle]);
    await patch("page_1", "Title: X\n\nAn overview.");
    expect(calls).toContainEqual({ path: "/blocks/blk_old", method: "DELETE" });
  });

  it("issues no DELETE when the page has no Summary toggle", async () => {
    const { patch, calls } = patcherOver([]);
    await patch("page_1", "Title: X\n\nAn overview.");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});
```

`NotionExporterOptions` already declares `fetch?: FetchLike` and `createRequest` already honours it, so the injection above works as written — no change needed to make the test possible.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx vitest run src/notionExporter.test.ts`
Expected: FAIL on the first case — no DELETE is issued, because the patcher only appends.

- [ ] **Step 3: Move the helper and make the patcher replace**

In `backend/src/notionUpdater.ts`: delete the `SUMMARY_TOGGLE` / `TRANSCRIPT_TOGGLE` consts and the whole private `findToggles` function, and import them instead:

```ts
import {
  NotionExporterOptions,
  Request,
  SUMMARY_TOGGLE,
  TRANSCRIPT_TOGGLE,
  appendChildren,
  appendToggle,
  createRequest,
  findToggles,
  label,
  pageTitle,
  readSchema,
} from "./notionExporter";
```

In `backend/src/notionExporter.ts`: add the moved definitions (place them above `createNotionSummaryPatcher`), exported:

```ts
export const SUMMARY_TOGGLE = "Summary";
export const TRANSCRIPT_TOGGLE = "Full transcript";

/**
 * Locate the page's Summary / Full transcript toggles by their titles, so a
 * page exported before these existed is handled without migration.
 */
export async function findToggles(
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
```

Then rewrite `createNotionSummaryPatcher`:

```ts
export function createNotionSummaryPatcher(
  opts: NotionExporterOptions,
): (pageId: string, summary: string) => Promise<void> {
  const request = createRequest(opts);
  return async (pageId, summary) => {
    const blocks = markdownToBlocks(parseSummary(summary).body);
    if (blocks.length === 0) return;
    // Replace rather than append: a regenerated summary must not leave the
    // page carrying two "Summary" toggles.
    const existing = await findToggles(request, pageId);
    if (existing.summary) await request(`/blocks/${existing.summary}`, "DELETE");
    await appendToggle(request, pageId, SUMMARY_TOGGLE, blocks);
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx vitest run src/notionExporter.test.ts src/notionUpdater.test.ts`
Expected: PASS — both new cases, and every pre-existing `notionUpdater` test still green (its behavior is unchanged; only where the helper lives moved).

- [ ] **Step 5: Commit**

```bash
cd backend && npm run build && npm test
git add src/notionExporter.ts src/notionUpdater.ts src/notionExporter.test.ts
git commit -m "fix(notion): replace the summary toggle instead of appending a second"
```

---

### Task 5: Add force mode to the backfill

**Files:**
- Modify: `backend/src/summaryBackfill.ts:11-27` (options), `:48-53` (skip logic)
- Test: `backend/src/summaryBackfill.test.ts`

**Interfaces:**
- Consumes: the replacing patcher from Task 4 (via `opts.patchPage`).
- Produces: `SummaryBackfillOptions` gains `force?: boolean` (default `false`). `backfillSummaries` keeps its existing signature and `SummaryBackfillResult` shape (`{ summarized, skipped, failed, patched }`). Iteration is **newest-first** (see the ordering correction below), so `force` + `limit: N` regenerates the newest N.

**Ordering correction (found during implementation).** An earlier draft of this
plan said `listTranscripts(dir).reverse()` yields newest-first. It does not:
`transcriptStore.ts:151` already sorts-and-reverses to newest-first, and
`summaryBackfill.ts:53` reverses again, giving oldest-first. Delete that second
`.reverse()` so line 53 reads `for (const listed of listTranscripts(opts.dir)) {`.
The boot sweep passes no `limit`, so it processes every unsummarized transcript
either way — only the sequence changes, and newest-first is better there too.

- [ ] **Step 1: Write the failing test**

Append to `backend/src/summaryBackfill.test.ts`, following the fixture helpers the file already uses to lay down transcripts in a temp dir:

```ts
it("skips already-summarized transcripts by default", async () => {
  const dir = makeDirWithTranscripts(3, { allSummarized: true });
  const result = await backfillSummaries({
    dir,
    summarize: async () => "Title: X\n\nBody.",
    delayMs: 0,
  });
  expect(result.summarized).toBe(0);
  expect(result.skipped).toBe(3);
});

it("regenerates already-summarized transcripts under force", async () => {
  const dir = makeDirWithTranscripts(3, { allSummarized: true });
  const result = await backfillSummaries({
    dir,
    force: true,
    summarize: async () => "Title: New\n\nRegenerated.",
    delayMs: 0,
  });
  expect(result.summarized).toBe(3);
  expect(result.skipped).toBe(0);
});

it("under force with a limit, regenerates only the newest N", async () => {
  const dir = makeDirWithTranscripts(5, { allSummarized: true });
  const result = await backfillSummaries({
    dir,
    force: true,
    limit: 2,
    summarize: async () => "Title: New\n\nRegenerated.",
    delayMs: 0,
  });
  expect(result.summarized).toBe(2);
  // The three older transcripts keep their original summaries byte-for-byte.
  const untouched = listTranscripts(dir)
    .slice(0, 3)
    .map((t) => readSummary(dir, t.name));
  expect(untouched.every((s) => s?.includes("Regenerated.") === false)).toBe(true);
});
```

If the file has no `makeDirWithTranscripts` helper, write one in the same style as its existing setup, taking `(count: number, opts: { allSummarized: boolean })` and writing `<name>.summary.md` alongside each transcript when `allSummarized` is true. Import `listTranscripts` and `readSummary` from `./transcriptStore`; if `readSummary` is not exported, read the file directly with `fs.readFileSync`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx vitest run src/summaryBackfill.test.ts`
Expected: the first case PASSES (that is today's behavior); the two `force` cases FAIL, reporting `summarized: 0`.

- [ ] **Step 3: Add the flag**

In `backend/src/summaryBackfill.ts`, add to `SummaryBackfillOptions`:

```ts
  /**
   * Re-summarize transcripts that already have a summary. Off by default: the
   * summary file is the done-marker, and the boot-time sweep must stay cheap.
   */
  force?: boolean;
```

Then change the skip check inside the loop from:

```ts
    if (listed.hasSummary) {
```

to:

```ts
    if (listed.hasSummary && !opts.force) {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx vitest run src/summaryBackfill.test.ts`
Expected: PASS — all three, plus every pre-existing case in the file.

- [ ] **Step 5: Commit**

```bash
cd backend && npm run build && npm test
git add src/summaryBackfill.ts src/summaryBackfill.test.ts
git commit -m "feat(summary): add force mode to the summary backfill"
```

---

### Task 6: Add the resummarize CLI entrypoint

**Files:**
- Create: `backend/src/chooseSummarizer.ts`
- Create: `backend/src/resummarize.ts`
- Modify: `backend/src/index.ts:24-42` (import the extracted chooser instead of defining it)
- Modify: `backend/package.json:6-12` (scripts)
- Test: `backend/src/resummarize.test.ts` (create)

**Interfaces:**
- Consumes: `backfillSummaries` with `force` from Task 5; `createNotionSummaryPatcher` from Task 4.
- Produces:
  - `chooseSummarizer(config: Config): Summarize | undefined` — extracted verbatim from `index.ts`, taking `config` as a parameter instead of closing over the module-scope constant.
  - `parseArgs(argv: string[]): { last: number }` — exported from `resummarize.ts` purely so the argument contract is testable without running the process. Throws `Error` on a missing or non-positive `--last`.

**Why the extraction:** `chooseSummarizer` currently lives in `index.ts` and closes over its module-scope `config`. Importing it from there would execute `index.ts` and start the relay. It also encodes real behavior — `SUMMARY_PROVIDER` overrides key-presence order — that regeneration must not silently diverge from. Extract once; both callers share it.

**Why a separate entrypoint:** `runBackfills()` in `src/index.ts` runs on every server boot. Regeneration must never be reachable from there, or each Fly.io restart re-summarizes the archive and bills for it. Do not import `resummarize.ts` from `index.ts`.

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
    expect(() => parseArgs([])).toThrow(/--last/);
  });

  it("rejects a non-positive count", () => {
    expect(() => parseArgs(["--last", "0"])).toThrow(/positive/i);
    expect(() => parseArgs(["--last", "abc"])).toThrow(/positive/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx vitest run src/resummarize.test.ts`
Expected: FAIL — `./resummarize` does not exist.

- [ ] **Step 3a: Extract the summarizer chooser**

Create `backend/src/chooseSummarizer.ts` — the body is moved verbatim from `index.ts`, with `config` becoming a parameter:

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

In `backend/src/index.ts`, delete the local `chooseSummarizer` function and its doc comment, drop the now-unused `createClaudeSummarizer` / `createGeminiSummarizer` imports, add `import { chooseSummarizer } from "./chooseSummarizer";`, and change the call site to:

```ts
const summarize = chooseSummarizer(config);
```

- [ ] **Step 3b: Write the entrypoint**

Create `backend/src/resummarize.ts`:

```ts
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
```

Every field referenced above is confirmed present on `Config` in `backend/src/config.ts`: `transcriptsDir: string`, `anthropicApiKey?: string`, `geminiApiKey?: string`, `summaryProvider?: SummaryProvider`, and `notion?: NotionConfig`. `loadConfig` takes `env` as a parameter — `loadConfig(process.env)`, not `loadConfig()`.

Add to `backend/package.json` scripts:

```json
    "resummarize": "tsx src/resummarize.ts",
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx vitest run src/resummarize.test.ts && npm run build`
Expected: PASS, and a clean type-check.

Then confirm the guard rail by hand:

Run: `cd backend && npm run resummarize`
Expected: exits non-zero, printing `--last is required.` and the usage line. **No model calls.**

- [ ] **Step 5: Commit**

```bash
cd backend && npm test
git add src/chooseSummarizer.ts src/resummarize.ts src/resummarize.test.ts src/index.ts package.json
git commit -m "feat(summary): add resummarize CLI for regenerating the newest N"
```

---

### Task 7: Render markdown on the watch

**Files:**
- Modify: `watch/WatchCaptions/Views/TranscriptDetailView.swift:38-43`
- Test: `watch/CaptionCore/Tests/CaptionCoreTests/` — see step 1

**Interfaces:**
- Consumes: summaries in the Task 1 format (`## ` headings, `- ` bullets).
- Produces: no API change. A private helper `attributed(_ markdown: String) -> AttributedString` local to the view.

**Why:** `Text(summary)` where `summary` is a `String` uses the non-`LocalizedStringKey` overload, which does not parse markdown. Today's `- ` bullets already render literally; Task 1's `## ` headings would make it worse.

- [ ] **Step 1: Write the failing test**

The rendering helper is pure and belongs where it can be tested. Add to `watch/CaptionCore/Sources/CaptionCore/History.swift` (alongside `summaryBody`):

```swift
public extension String {
    /// Parse a stored summary as markdown, falling back to the literal text.
    ///
    /// Summaries are written as markdown by the relay; SwiftUI's `Text(String)`
    /// overload does not parse it, so headings and bullets would otherwise show
    /// their syntax characters on the wrist.
    var asSummaryMarkdown: AttributedString {
        (try? AttributedString(
            markdown: self,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )) ?? AttributedString(self)
    }
}
```

Create `watch/CaptionCore/Tests/CaptionCoreTests/SummaryMarkdownTests.swift`:

```swift
import XCTest
@testable import CaptionCore

final class SummaryMarkdownTests: XCTestCase {
    func testStripsBulletSyntaxFromRenderedText() {
        let rendered = String("- first\n- second".asSummaryMarkdown.characters)
        XCTAssertFalse(rendered.contains("- "), "bullet syntax should not survive into the rendered text")
        XCTAssertTrue(rendered.contains("first"))
    }

    func testKeepsHeadingTextWithoutHashes() {
        let rendered = String("## Feature freeze".asSummaryMarkdown.characters)
        XCTAssertFalse(rendered.contains("#"))
        XCTAssertTrue(rendered.contains("Feature freeze"))
    }

    func testFallsBackToPlainTextOnUnparseableInput() {
        let rendered = String("plain text".asSummaryMarkdown.characters)
        XCTAssertEqual(rendered, "plain text")
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd watch/CaptionCore && swift test --filter SummaryMarkdownTests`
Expected: FAIL to compile — `asSummaryMarkdown` does not exist until you add the extension in step 3.

(If step 1's extension was already added, remove it, confirm the failure, then re-add. The point is to see red before green.)

- [ ] **Step 3: Add the extension and use it in the view**

Add the `asSummaryMarkdown` extension from step 1 to `History.swift` if not already present.

In `watch/WatchCaptions/Views/TranscriptDetailView.swift`, change:

```swift
                if let summary = detail.summaryBody {
                    Text(summary).font(.system(size: 14))
                } else {
```

to:

```swift
                if let summary = detail.summaryBody {
                    Text(summary.asSummaryMarkdown).font(.system(size: 14))
                } else {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd watch/CaptionCore && swift test --filter SummaryMarkdownTests`
Expected: PASS.

Run: `cd watch/CaptionCore && swift test`
Expected: PASS — the whole CaptionCore suite, including the existing `HistoryStoreTests` and `TranscriptDecodingTests`.

- [ ] **Step 5: Commit**

```bash
git add watch/CaptionCore/Sources/CaptionCore/History.swift \
        watch/CaptionCore/Tests/CaptionCoreTests/SummaryMarkdownTests.swift \
        watch/WatchCaptions/Views/TranscriptDetailView.swift
git commit -m "feat(watch): render summary markdown instead of showing its syntax"
```

---

### Task 8: Update the README and run the whole suite

**Files:**
- Modify: `backend/README.md`
- Test: none new — this task's gate is the full suite going green.

**Interfaces:**
- Consumes: everything above.
- Produces: documentation only.

- [ ] **Step 1: Document the new script**

In `backend/README.md`, add a section near the existing backfill documentation:

```markdown
### Regenerating summaries

Stored summaries are written once and never revisited — the `<name>.summary.md`
file is the done-marker for the boot-time backfill. To re-summarize existing
transcripts under a newer prompt:

```sh
npm run resummarize -- --last 20     # the 20 most recent transcripts
npm run resummarize -- --last 9999   # the whole archive
```

`--last` is required; without it the script exits non-zero rather than
regenerating everything by accident. Each transcript is a paid model call, and
the script prints how many it will do before starting. Notion pages that were
already exported have their Summary toggle replaced, not duplicated.

This is deliberately **not** part of the boot-time sweep in `index.ts` — that
runs on every restart.
```

- [ ] **Step 2: Run the full backend suite**

Run: `cd backend && npm test && npm run build`
Expected: PASS, clean type-check.

- [ ] **Step 3: Run the full watch suite**

Run: `cd watch/CaptionCore && swift test`
Expected: PASS.

- [ ] **Step 4: Confirm the boot path is untouched**

Run: `cd backend && grep -n "force" src/index.ts`
Expected: **no output.** If `force` appears in `index.ts`, regeneration has leaked into the boot sweep — remove it.

- [ ] **Step 5: Commit**

```bash
git add backend/README.md
git commit -m "docs: document the resummarize script"
```

---

## Manual verification (after Task 8)

The suite cannot prove the summaries actually got better — that needs one real call.

1. Deploy the backend, or run it locally against a copy of the transcripts directory.
2. `npm run resummarize -- --last 1` and read the result. Check: does it have `##` sections? Do the section count and depth match the recording's length? Are names and numbers preserved?
3. Open that transcript on the watch. Confirm headings and bullets render as formatting, not as `##` and `- `.
4. If it was already exported, open the Notion page and confirm there is exactly **one** Summary toggle.
5. Only then run a larger `--last N`.
