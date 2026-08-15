import { FinalizedTranscript } from "./transcriptStore";
import { parseSummary } from "./summaryPrompt";
import { ExportDestinationStore } from "./exportDestinations";

export interface SendEmailArgs {
  to: string;
  subject: string;
  text: string;
}

export type SendEmail = (args: SendEmailArgs) => Promise<void>;

/**
 * Resend's REST API behind one `fetch`, so email costs no dependency and
 * stays testable without a network.
 */
export function createResendSender(
  apiKey: string,
  from: string,
  fetchImpl: typeof fetch = fetch,
): SendEmail {
  return async ({ to, subject, text }) => {
    const res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to, subject, text }),
    });
    if (!res.ok) {
      throw new Error(`email send failed: ${res.status} ${await res.text()}`);
    }
  };
}

/** Plain text, because a transcript is plain text and HTML would add nothing. */
export function transcriptEmail(
  t: FinalizedTranscript,
  summary: string | null,
): { subject: string; text: string } {
  const title = summary ? parseSummary(summary).title : undefined;
  const date = t.startedAt.slice(0, 10);
  const subject = title ? `Transcript: ${title}` : `Transcript: ${date}`;
  const body = [
    summary ? `${summary}\n` : "",
    "---",
    "",
    ...t.segments.map((s) => s.text),
  ].join("\n");
  return { subject, text: body };
}

/**
 * Builds the `FinalizerOptions.sendTranscriptEmail` callback: mail this
 * transcript to the caller's stored email destination, but only once it has
 * been verified.
 *
 * An unverified address makes the relay a remailer for anyone who can
 * register; a verified-but-wrong one is a privacy incident the user cannot
 * undo. So this is the single choke point that decides whether a transcript
 * — including the speech of bystanders who never consented — actually goes
 * out, and it must never send to an address whose `verifiedAt` is unset.
 */
export function createTranscriptEmailSender(
  destinations: ExportDestinationStore,
  sendEmail: SendEmail,
): (userId: string, t: FinalizedTranscript, summary: string | null) => Promise<void> {
  return async (userId, t, summary) => {
    const destination = destinations.getEmail(userId);
    if (!destination?.verifiedAt) return;
    const { subject, text } = transcriptEmail(t, summary);
    await sendEmail({ to: destination.address, subject, text });
  };
}
