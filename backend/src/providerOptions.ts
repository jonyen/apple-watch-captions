/**
 * "deepgram" is retired (2026-08): no Deepgram client exists anymore, and a
 * session requesting it gets an `UnavailableProvider` error. It stays in this
 * list so the name is still *recognized* — an old client asking for it gets a
 * clear "not configured" session error instead of `/stream`'s 4002 "unknown
 * provider" close or `/v1/audio`'s silent fallback to the relay default.
 */
export const PROVIDER_NAMES = ["deepgram", "openai", "assemblyai", "apple"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export interface ProviderOptions {
  channels?: number;
  /** Requested transcription backend; absent = the relay's configured default. */
  provider?: ProviderName;
}
