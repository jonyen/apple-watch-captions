export interface VoiceResponseOptions {
  /** Where Twilio should open the media stream. */
  streamUrl: string;
  /** The number to bridge the caller to. */
  dialTo: string;
  /**
   * Optional; where Twilio reports the stream's lifecycle and failures.
   * Without it a stream that never connects is invisible from this side —
   * the relay simply never hears from Twilio, and the alert Twilio files
   * carries an error code and nothing else.
   */
  streamStatusUrl?: string;
}

/**
 * TwiML for an inbound captioned call: fork the caller's audio to the relay,
 * then bridge the call onward.
 *
 * `<Start><Stream>` is deliberately the non-blocking form — Twilio sets the
 * stream up and immediately continues to the next verb, so the caller hears
 * normal ringing while audio is already flowing. `<Connect><Stream>` would
 * block until the socket closed and the call would never be bridged.
 */
export function voiceResponse({
  streamUrl,
  dialTo,
  streamStatusUrl,
}: VoiceResponseOptions): string {
  const status = streamStatusUrl
    ? ` statusCallback="${escapeXml(streamStatusUrl)}" statusCallbackMethod="POST"`
    : "";
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    "<Start>",
    `<Stream url="${escapeXml(streamUrl)}" track="inbound_track"${status}/>`,
    "</Start>",
    `<Dial>${escapeXml(dialTo)}</Dial>`,
    "</Response>",
  ].join("");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
