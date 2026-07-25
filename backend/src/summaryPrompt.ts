import { FinalizedTranscript } from "./transcriptStore";

/** Shared by every summarizer backend, so switching providers doesn't change the output shape. */
export const SUMMARY_SYSTEM_PROMPT =
  "You summarize transcripts captured by a live-captioning watch app. " +
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
