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
      }),
    } as RequestInit);

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = (payload as any)?.error?.message ?? "unknown error";
      throw new Error(`Gemini request failed: ${response.status} ${message}`);
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
