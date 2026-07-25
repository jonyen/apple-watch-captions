import { describe, it, expect, vi } from "vitest";
import { createGeminiSummarizer } from "./geminiSummarizer";
import { FinalizedTranscript } from "./transcriptStore";

function transcript(segments?: FinalizedTranscript["segments"]): FinalizedTranscript {
  return {
    name: "2026-07-06T01-02-03Z_abc",
    sessionId: "abc",
    startedAt: "2026-07-06T01:02:03Z",
    endedAt: "2026-07-06T01:05:03Z",
    segments: segments ?? [
      { at: "2026-07-06T01:02:03Z", text: "hello there" },
      { at: "2026-07-06T01:02:09Z", text: "how are you" },
    ],
  };
}

function json(body: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Response shaped like the documented convenience field. */
const withOutputText = (text: string) => json({ output_text: text });

/** Response shaped like raw step/content blocks, without the convenience field. */
const withSteps = (text: string) =>
  json({ steps: [{ content: [{ type: "text", text }] }] });

describe("createGeminiSummarizer", () => {
  it("posts the transcript to the interactions endpoint with the api key", async () => {
    const fetch = vi.fn(async () => withOutputText("A chat happened."));
    const summarize = createGeminiSummarizer("gk-123", { fetch: fetch as any });

    await summarize(transcript());

    const [url, init] = fetch.mock.calls[0] as unknown as [string, any];
    expect(url).toContain("/v1beta/interactions");
    expect(init.method).toBe("POST");
    expect(init.headers["x-goog-api-key"]).toBe("gk-123");
    const body = JSON.parse(init.body);
    expect(body.model).toContain("flash");
    expect(body.input).toContain("hello there");
    expect(body.system_instruction).toContain("summar");
  });

  it("returns the generated summary", async () => {
    const fetch = vi.fn(async () => withOutputText("A chat happened."));
    const summarize = createGeminiSummarizer("gk-123", { fetch: fetch as any });

    expect(await summarize(transcript())).toBe("A chat happened.");
  });

  it("reads the text out of step content when the convenience field is absent", async () => {
    const fetch = vi.fn(async () => withSteps("A chat happened."));
    const summarize = createGeminiSummarizer("gk-123", { fetch: fetch as any });

    expect(await summarize(transcript())).toBe("A chat happened.");
  });

  it("parses the shape the live API actually returns", async () => {
    // Captured from a real POST /v1beta/interactions response. There is no
    // output_text on raw REST (that is an SDK convenience), and the thought
    // step carries no `content` — a parser that assumes it does will throw.
    const live = {
      id: "v1_Chd6U2Rr",
      status: "completed",
      object: "interaction",
      model: "gemini-3.6-flash",
      usage: { total_tokens: 75, total_thought_tokens: 69 },
      steps: [
        { type: "thought", signature: "EskCCsYCARFNMg" },
        { type: "model_output", content: [{ type: "text", text: "A chat happened." }] },
      ],
    };
    const fetch = vi.fn(async () => json(live));
    const summarize = createGeminiSummarizer("gk-123", { fetch: fetch as any });

    expect(await summarize(transcript())).toBe("A chat happened.");
  });

  it("throws rather than returning empty when no text can be found", async () => {
    // A silent "" here is what let the previous summarizer fail invisibly:
    // the finalizer skips empty summaries without logging a failure.
    const fetch = vi.fn(async () => json({ steps: [] }));
    const summarize = createGeminiSummarizer("gk-123", { fetch: fetch as any });

    await expect(summarize(transcript())).rejects.toThrow(/no summary text/i);
  });

  it("throws with the API status and message when the request fails", async () => {
    const fetch = vi.fn(async () =>
      json({ error: { message: "API key not valid" } }, 400),
    );
    const summarize = createGeminiSummarizer("gk-123", { fetch: fetch as any });

    await expect(summarize(transcript())).rejects.toThrow(/400.*API key not valid/s);
  });

  it("labels dual-channel segments as Me and Them", async () => {
    const fetch = vi.fn(async () => withOutputText("s"));
    const summarize = createGeminiSummarizer("gk-123", { fetch: fetch as any });

    await summarize(
      transcript([
        { at: "2026-07-06T01:02:03Z", text: "my line", channel: 0 },
        { at: "2026-07-06T01:02:09Z", text: "their line", channel: 1 },
      ]),
    );

    const body = JSON.parse((fetch.mock.calls[0] as any)[1].body);
    expect(body.input).toContain("Me: my line");
    expect(body.input).toContain("Them: their line");
  });

  it("uses the configured model when one is given", async () => {
    const fetch = vi.fn(async () => withOutputText("s"));
    const summarize = createGeminiSummarizer("gk-123", {
      fetch: fetch as any,
      model: "gemini-3.6-flash-lite",
    });

    await summarize(transcript());

    expect(JSON.parse((fetch.mock.calls[0] as any)[1].body).model).toBe(
      "gemini-3.6-flash-lite",
    );
  });
});
