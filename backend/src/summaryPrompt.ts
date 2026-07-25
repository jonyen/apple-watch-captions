import { FinalizedTranscript } from "./transcriptStore";

/** Shared by every summarizer backend, so switching providers doesn't change the output shape. */
export const SUMMARY_SYSTEM_PROMPT =
  "You summarize transcripts captured by a live-captioning watch app. " +
  "Begin your reply with a single line of the form 'Title: <short title>' — " +
  "at most 10 words naming what the recording is about, with no trailing " +
  "punctuation. Then a blank line, then the summary itself. " +
  "The transcript is one side or a mix of a real-world conversation and may " +
  "contain transcription errors. Write a concise markdown summary: 1-2 " +
  "sentence overview, then key points as bullets. If action items or " +
  "decisions are mentioned, list them under an 'Action items' heading. " +
  "Do not invent details that are not in the transcript. " +
  "Lines prefixed 'Me:' were spoken by the user; lines prefixed 'Them:' are the other party or audio playing on their device.";

/** Transcript lines, with Me/Them prefixes for dual-channel sessions. */
export function formatTranscript(t: FinalizedTranscript): string {
  return t.segments
    .map((s) => (s.channel === 0 ? `Me: ${s.text}` : s.channel === 1 ? `Them: ${s.text}` : s.text))
    .join("\n");
}

/** The user-turn prompt for a transcript. */
export function summaryPrompt(t: FinalizedTranscript): string {
  return `Transcript from ${t.startedAt} to ${t.endedAt}:\n\n${formatTranscript(t)}`;
}

/** Longest title we will put on a page name. */
const MAX_TITLE = 120;

export interface ParsedSummary {
  /** Absent for summaries written before titles existed. */
  title?: string;
  /** The summary without its title line. */
  body: string;
}

/**
 * Split the model's `Title:` first line off the summary body.
 *
 * The raw text stays on disk exactly as generated; parsing happens on read so
 * older summaries keep working and nothing needs migrating.
 */
export function parseSummary(raw: string): ParsedSummary {
  const newline = raw.indexOf("\n");
  const firstLine = (newline === -1 ? raw : raw.slice(0, newline)).trim();

  // Allow the model to dress the line up as bold or a heading.
  const match = /^(?:\*\*|#{1,6}\s*)?Title:\*{0,2}\s*(.*?)\s*\*{0,2}$/.exec(firstLine);
  if (!match) return { body: raw };

  const title = match[1].trim();
  const body = newline === -1 ? "" : raw.slice(newline + 1).replace(/^\n+/, "");
  if (title.length === 0) return { body };
  return { title: title.slice(0, MAX_TITLE), body };
}
