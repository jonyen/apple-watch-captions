import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createFinalizer } from "./finalizer";
import { createTranscriptMailer, TransportLike } from "./mailer";
import { FinalizedTranscript, readTranscript, TranscriptStore, listTranscripts } from "./transcriptStore";

function transcript(texts: string[]): FinalizedTranscript {
  return {
    name: "2026-07-06T01-02-03Z_abc",
    sessionId: "abc",
    startedAt: "2026-07-06T01:02:03Z",
    endedAt: "2026-07-06T01:05:03Z",
    segments: texts.map((text, i) => ({ at: `2026-07-06T01:02:0${i}Z`, text })),
  };
}

const LONG = ["this is a reasonably long caption about something", "and another one"];

/** The finalizer runs async fire-and-forget; give its promise chain a tick. */
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("createFinalizer", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "finalizer-"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("stores the summary and emails it", async () => {
    // Create the transcript file so writeSummary has a sibling.
    const store = new TranscriptStore({ dir, now: () => Date.UTC(2026, 6, 6, 1, 2, 3) });
    store.append("abc", LONG[0]);
    const name = listTranscripts(dir)[0].name;

    const emails: { name: string; summary: string }[] = [];
    const finalize = createFinalizer({
      dir,
      summarize: async () => "A chat happened.",
      sendEmail: async (t, summary) => {
        emails.push({ name: t.name, summary });
      },
    });
    finalize({ ...transcript(LONG), name });
    await settle();

    expect(readTranscript(dir, name)?.summary).toBe("A chat happened.");
    expect(emails).toEqual([{ name, summary: "A chat happened." }]);
  });

  it("still emails when the summarizer fails", async () => {
    const emails: string[] = [];
    const finalize = createFinalizer({
      dir,
      summarize: async () => {
        throw new Error("api down");
      },
      sendEmail: async (_t, summary) => {
        emails.push(summary);
      },
    });
    finalize(transcript(LONG));
    await settle();
    expect(emails).toEqual([""]);
  });

  it("skips near-empty transcripts", async () => {
    const summarize = vi.fn(async () => "s");
    const sendEmail = vi.fn(async () => {});
    createFinalizer({ dir, summarize, sendEmail })(transcript(["hi"]));
    await settle();
    expect(summarize).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("survives a failing email", async () => {
    const finalize = createFinalizer({
      dir,
      sendEmail: async () => {
        throw new Error("smtp down");
      },
    });
    expect(() => finalize(transcript(LONG))).not.toThrow();
    await settle();
  });
});

describe("createTranscriptMailer", () => {
  it("sends a mail with summary, count, and viewer link", async () => {
    const sent: any[] = [];
    const transport: TransportLike = {
      sendMail: async (mail) => {
        sent.push(mail);
      },
    };
    const send = createTranscriptMailer(
      { user: "me@gmail.com", pass: "app-pass", to: "you@gmail.com", appUrl: "https://relay.fly.dev/" },
      transport,
    );
    await send(transcript(LONG), "Key points here.");

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("you@gmail.com");
    expect(sent[0].from).toContain("me@gmail.com");
    expect(sent[0].subject).toContain("2 captions");
    expect(sent[0].text).toContain("Key points here.");
    expect(sent[0].text).toContain("https://relay.fly.dev/app");
    expect(sent[0].html).toContain("https://relay.fly.dev/app");
  });

  it("notes when no summary was generated and omits a missing viewer link", async () => {
    const sent: any[] = [];
    const transport: TransportLike = {
      sendMail: async (mail) => {
        sent.push(mail);
      },
    };
    const send = createTranscriptMailer(
      { user: "me@gmail.com", pass: "p", to: "you@gmail.com" },
      transport,
    );
    await send(transcript(LONG), "");
    expect(sent[0].text).toContain("no summary was generated");
    expect(sent[0].html).not.toContain("<a href");
  });

  it("escapes HTML in the summary", async () => {
    const sent: any[] = [];
    const transport: TransportLike = {
      sendMail: async (mail) => {
        sent.push(mail);
      },
    };
    const send = createTranscriptMailer(
      { user: "me@gmail.com", pass: "p", to: "you@gmail.com" },
      transport,
    );
    await send(transcript(LONG), "<script>alert(1)</script>");
    expect(sent[0].html).not.toContain("<script>");
    expect(sent[0].html).toContain("&lt;script&gt;");
  });
});
