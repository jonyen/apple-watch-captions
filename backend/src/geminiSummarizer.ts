import { Summarize } from "./summarizer";
import { SUMMARY_SYSTEM_PROMPT, summaryPrompt } from "./summaryPrompt";

const API = "https://generativelanguage.googleapis.com/v1beta/interactions";
const DEFAULT_MODEL = "gemini-3.6-flash";

/**
 * Output cap shared between the request body and the truncation check below,
 * so the two numbers can't drift apart.
 */
const MAX_OUTPUT_TOKENS = 16000;

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface GeminiSummarizerOptions {
  /** Defaults to Gemini Flash. */
  model?: string;
  /** Injectable for tests. */
  fetch?: FetchLike;
}

/**
 * Gemini-backed summarizer — the free-tier alternative to Claude.
 *
 * Note the free tier may use inputs to improve Google's products; the paid
 * tier does not. Transcripts can contain sensitive material, so choose the
 * provider deliberately.
 */
export function createGeminiSummarizer(
  apiKey: string,
  opts: GeminiSummarizerOptions = {},
): Summarize {
  const doFetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const model = opts.model ?? DEFAULT_MODEL;

  return async (transcript) => {
    const response = await doFetch(API, {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: summaryPrompt(transcript),
        system_instruction: SUMMARY_SYSTEM_PROMPT,
        // Summarizing is not a reasoning-heavy task, and the free tier is
        // capped on daily tokens — thinking defaults high enough to dominate
        // the bill (69 thought tokens for a 2-token reply, measured).
        // The output cap matches the Claude path so the two providers produce
        // comparable lengths from the same prompt.
        generation_config: { thinking_level: "low", max_output_tokens: MAX_OUTPUT_TOKENS },
      }),
    } as RequestInit);

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = (payload as any)?.error?.message ?? "unknown error";
      throw new Error(`Gemini request failed: ${response.status} ${message}`);
    }

    // A truncated summary must not be stored: the summary file is the
    // done-marker, so a partial would never be revisited. Mirrors the Claude
    // path's stop_reason check (summarizer.ts).
    const truncation = truncationReason(payload);
    if (truncation) {
      throw new Error(`${truncation} for ${transcript.name}`);
    }

    const text = extractText(payload);
    if (text === undefined || text.trim().length === 0) {
      // Never return "" — the finalizer skips empty summaries silently, which
      // is exactly how the previous summarizer failed without a trace.
      throw new Error(`Gemini returned no summary text: ${JSON.stringify(payload).slice(0, 300)}`);
    }
    return text;
  };
}

/**
 * Describes why the response looks incomplete/truncated, or returns
 * `undefined` if it looks fine. Checked defensively, like `extractText`
 * below: every field read here is optional-chained, so a payload missing
 * all of them returns `undefined` rather than throwing or crashing — a
 * truncated/unrecognized-shape response must never be mistaken for a normal
 * one, but an absent field must never be mistaken for a problem either.
 *
 * Three signals, in the order checked:
 *
 * 1. Legacy `generateContent` shape: `candidates[0].finishReason ===
 *    "MAX_TOKENS"`. Documented behavior, and the shape `extractText` above
 *    already has a fallback branch for.
 *
 * 2. Live `steps`/interactions shape — the shape this summarizer actually
 *    calls in production. `status` reads `"completed"` on every real
 *    response captured so far (see the "parses the shape the live API
 *    actually returns" test below). Any other value on an HTTP-ok payload
 *    is treated as a generation that didn't finish.
 *
 * 3. Same live shape, derived from token accounting: `usage.total_tokens`
 *    covers thought *and* output tokens together (not input) — confirmed by
 *    the captured fixture, where `total_tokens(75) - total_thought_tokens(69)
 *    = 6`, matching the six-token body "A chat happened." So
 *    `total_tokens - total_thought_tokens` is the actual output length;
 *    reaching the configured cap means the model was cut off even when
 *    `status` doesn't say so (e.g. if the API marks a cut-off response
 *    "completed" the way some providers do).
 */
function truncationReason(payload: any): string | undefined {
  if (payload?.candidates?.[0]?.finishReason === "MAX_TOKENS") {
    return "Gemini summary truncated at the token ceiling";
  }

  if (typeof payload?.status === "string" && payload.status !== "completed") {
    return `Gemini summary generation did not complete (status: ${payload.status})`;
  }

  const usage = payload?.usage;
  if (typeof usage?.total_tokens === "number" && typeof usage?.total_thought_tokens === "number") {
    const outputTokens = usage.total_tokens - usage.total_thought_tokens;
    if (outputTokens >= MAX_OUTPUT_TOKENS) {
      return "Gemini summary truncated at the token ceiling";
    }
  }

  return undefined;
}

/**
 * The response carries the text either in the `output_text` convenience field
 * or inside the step/content blocks; accept whichever is present rather than
 * betting on one shape.
 */
function extractText(payload: any): string | undefined {
  if (typeof payload?.output_text === "string") return payload.output_text;

  const fromBlocks = (payload?.steps ?? [])
    .flatMap((step: any) => step?.content ?? [])
    .map((block: any) => block?.text)
    .filter((t: unknown): t is string => typeof t === "string" && t.length > 0)
    .join("\n");
  if (fromBlocks.length > 0) return fromBlocks;

  // Legacy generateContent shape, in case the endpoint is pointed back at it.
  const fromCandidates = (payload?.candidates ?? [])
    .flatMap((c: any) => c?.content?.parts ?? [])
    .map((p: any) => p?.text)
    .filter((t: unknown): t is string => typeof t === "string" && t.length > 0)
    .join("\n");
  return fromCandidates.length > 0 ? fromCandidates : undefined;
}
