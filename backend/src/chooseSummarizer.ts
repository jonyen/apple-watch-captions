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
