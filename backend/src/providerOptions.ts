export const PROVIDER_NAMES = ["deepgram", "openai", "assemblyai"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export interface ProviderOptions {
  channels?: number;
  /** Requested transcription backend; absent = deepgram. */
  provider?: ProviderName;
  /**
   * Telephony audio: μ-law 8 kHz off a phone call rather than 16 kHz PCM from
   * a microphone. Decides the Deepgram encoding and model for the session.
   */
  telephony?: boolean;
}
