import { createTransport } from "nodemailer";
import { FinalizedTranscript } from "./transcriptStore";
import { SendTranscriptEmail } from "./finalizer";

export interface MailConfig {
  /** Gmail address the mail is sent from (SMTP username). */
  user: string;
  /** Gmail app password. */
  pass: string;
  /** Recipient. */
  to: string;
  /** Origin of the deployed relay, used to link to the viewer (e.g. https://app.fly.dev). */
  appUrl?: string;
}

/** Minimal slice of nodemailer's Transporter (keeps the mailer testable). */
export interface TransportLike {
  sendMail(mail: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html: string;
  }): Promise<unknown>;
}

/**
 * "Transcript ready" email via Gmail SMTP — the same account the weekly
 * usage-report workflow sends from (MAIL_USERNAME / MAIL_PASSWORD).
 */
export function createTranscriptMailer(
  cfg: MailConfig,
  transport: TransportLike = createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: cfg.user, pass: cfg.pass },
  }),
): SendTranscriptEmail {
  return async (t, summary) => {
    // Server clock is UTC unless TZ is set on the machine (fly.toml [env]).
    const started = new Date(t.startedAt).toLocaleString([], {
      dateStyle: "medium",
      timeStyle: "short",
    });
    const count = t.segments.length;
    const viewerUrl = cfg.appUrl ? `${cfg.appUrl.replace(/\/$/, "")}/app` : null;

    const subject = `Transcript ready — ${started} (${count} caption${count === 1 ? "" : "s"})`;
    const summaryText = summary || "(no summary was generated)";
    const text = [
      `A captioning session finished at ${new Date(t.endedAt).toLocaleString()}.`,
      "",
      "Summary:",
      summaryText,
      "",
      viewerUrl ? `View the full transcript: ${viewerUrl}` : "",
    ].join("\n");

    const html = `
      <div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:600px">
        <h2 style="font-size:18px">Transcript ready</h2>
        <p style="color:#555">${escapeHtml(started)} &middot; ${count} caption${count === 1 ? "" : "s"}</p>
        <div style="border-left:3px solid #ccc;padding-left:12px;white-space:pre-wrap">${escapeHtml(summaryText)}</div>
        ${
          viewerUrl
            ? `<p><a href="${escapeHtml(viewerUrl)}" style="display:inline-block;background:#111;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Open transcript viewer</a></p>`
            : ""
        }
      </div>`;

    await transport.sendMail({
      from: `Watch Captions <${cfg.user}>`,
      to: cfg.to,
      subject,
      text,
      html,
    });
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
