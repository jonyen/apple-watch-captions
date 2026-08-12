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
