import Anthropic from "@anthropic-ai/sdk";
import { FinalizedTranscript } from "./transcriptStore";
import { SUMMARY_SYSTEM_PROMPT, summaryPrompt } from "./summaryPrompt";

export type Summarize = (transcript: FinalizedTranscript) => Promise<string>;

/** Claude-backed summarizer. */
export function createClaudeSummarizer(apiKey: string): Summarize {
  const client = new Anthropic({ apiKey });
  return async (t) => {
    const response = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 2048,
      thinking: { type: "adaptive" },
      system: SUMMARY_SYSTEM_PROMPT,
      messages: [{ role: "user", content: summaryPrompt(t) }],
    });
    const block = response.content.find((b) => b.type === "text");
    return block?.type === "text" ? block.text : "";
  };
}
