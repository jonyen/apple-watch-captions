import Anthropic from "@anthropic-ai/sdk";
import { FinalizedTranscript } from "./transcriptStore";
import { SUMMARY_SYSTEM_PROMPT, summaryPrompt } from "./summaryPrompt";

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
