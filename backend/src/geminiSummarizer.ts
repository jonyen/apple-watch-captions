import { Summarize } from "./summarizer";
import { SUMMARY_SYSTEM_PROMPT, summaryPrompt } from "./summaryPrompt";

const API = "https://generativelanguage.googleapis.com/v1beta/interactions";
const DEFAULT_MODEL = "gemini-3.6-flash";

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
        generation_config: { thinking_level: "low", max_output_tokens: 16000 },
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
    if (isTruncated(payload)) {
      throw new Error(`Gemini summary truncated at the token ceiling for ${transcript.name}`);
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
 * Whether the response signals it was cut off at `max_output_tokens` rather
 * than finishing naturally. Checked defensively, like `extractText` below:
 * an absent or unrecognized marker means "not truncated", not an error, so
 * this can never break a currently-passing shape.
 *
 * Only the legacy `generateContent` shape's `candidates[0].finishReason ===
 * "MAX_TOKENS"` is handled with any confidence — that field is documented
 * and this file already has a captured example of the shape around it. The
 * newer `steps`/interactions shape (the one this summarizer actually calls)
 * has no confirmed finish-reason equivalent: no truncated example of it has
 * been captured, and the one live response on file (see the "parses the
 * shape the live API actually returns" test) carries only `status:
 * "completed"` with no hint of what a cut-off response would say. Rather
 * than guess a field name for that shape, it is left unchecked here — a
 * truncation on that path would currently slip through uncaught.
 */
function isTruncated(payload: any): boolean {
  return payload?.candidates?.[0]?.finishReason === "MAX_TOKENS";
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
