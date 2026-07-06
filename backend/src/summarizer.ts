import Anthropic from "@anthropic-ai/sdk";
import { FinalizedTranscript, writeSummary } from "./transcriptStore";

/** Skip summarizing transcripts with almost no content. */
const MIN_TRANSCRIPT_CHARS = 40;

export type Summarize = (transcript: FinalizedTranscript) => Promise<string>;

/** Claude-backed summarizer. */
export function createClaudeSummarizer(apiKey: string): Summarize {
  const client = new Anthropic({ apiKey });
  return async (t) => {
    const text = t.segments.map((s) => s.text).join("\n");
    const response = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 2048,
      thinking: { type: "adaptive" },
      system:
        "You summarize transcripts captured by a live-captioning watch app. " +
        "The transcript is one side or a mix of a real-world conversation and may " +
        "contain transcription errors. Write a concise markdown summary: 1-2 " +
        "sentence overview, then key points as bullets. If action items or " +
        "decisions are mentioned, list them under an 'Action items' heading. " +
        "Do not invent details that are not in the transcript.",
      messages: [
        {
          role: "user",
          content: `Transcript from ${t.startedAt} to ${t.endedAt}:\n\n${text}`,
        },
      ],
    });
    const block = response.content.find((b) => b.type === "text");
    return block?.type === "text" ? block.text : "";
  };
}

/**
 * When a transcript finalizes, generate its summary and store it next to the
 * JSONL file. Failures are logged, never fatal — the transcript itself is
 * already safely on disk.
 */
export function summarizeOnFinalize(dir: string, summarize: Summarize) {
  return (t: FinalizedTranscript): void => {
    const chars = t.segments.reduce((n, s) => n + s.text.length, 0);
    if (chars < MIN_TRANSCRIPT_CHARS) return;
    summarize(t)
      .then((summary) => {
        if (summary.length === 0) return;
        writeSummary(dir, t.name, summary);
        console.log(`summary written for ${t.name}`);
      })
      .catch((err) => {
        console.error(`summary failed for ${t.name}:`, err);
      });
  };
}
