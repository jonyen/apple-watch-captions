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

export interface RingbackOptions {
  /** Where the ringback tone is served from. */
  ringbackUrl: string;
  /** The webhook to come back to, carrying the next attempt number. */
  nextUrl: string;
}

/**
 * Ring the caller once, then ask Twilio to come back and check whether the
 * watch has arrived. The retry count rides in `nextUrl`, so the relay keeps no
 * per-call state about ringing.
 */
export function ringbackResponse({ ringbackUrl, nextUrl }: RingbackOptions): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    `<Play>${escapeXml(ringbackUrl)}</Play>`,
    `<Redirect>${escapeXml(nextUrl)}</Redirect>`,
    "</Response>",
  ].join("");
}

export interface ConnectStreamOptions {
  streamUrl: string;
  streamStatusUrl?: string;
}

/**
 * Hand the call to the relay.
 *
 * `<Connect>` is the blocking, bidirectional form: Twilio holds the call open
 * for exactly as long as the WebSocket lives, and audio flows both ways. That
 * is what makes Twilio the call's owner and leaves neither phone nor watch in
 * a call. `<Start>` — phase 1's form — would return immediately and the call
 * would end.
 */
export function connectStreamResponse({
  streamUrl,
  streamStatusUrl,
}: ConnectStreamOptions): string {
  const status = streamStatusUrl
    ? ` statusCallback="${escapeXml(streamStatusUrl)}" statusCallbackMethod="POST"`
    : "";
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    "<Connect>",
    `<Stream url="${escapeXml(streamUrl)}"${status}/>`,
    "</Connect>",
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
