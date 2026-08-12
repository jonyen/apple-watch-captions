import { PROVIDER_NAMES, ProviderName } from "./providerOptions";

/**
 * Settings the phone writes and the watch reads.
 *
 * They live on the relay because the two apps cannot talk to each other: the
 * watch app is standalone (`WKWatchOnly`), so there is no paired-companion
 * WatchConnectivity session between them. The relay is already the thing both
 * devices share, and putting settings there means the mac app can read them too
 * without anything new.
 */
export interface Settings {
  /** Caption font size on the watch, in points. */
  captionTextSize: number;
  /** Open iPhone audio on launch when the phone is broadcasting. */
  autoOpenPhoneAudio: boolean;
  /** Whether a new mic session is written down or kept live-only. */
  saveTranscripts: boolean;
  /** Which speech provider the relay transcribes with. */
  provider: ProviderName;
}

export const DEFAULT_SETTINGS: Settings = {
  captionTextSize: 16,
  autoOpenPhoneAudio: true,
  saveTranscripts: true,
  provider: "deepgram",
};

/** The range the watch can actually render legibly on a 40 mm case. */
export const MIN_TEXT_SIZE = 12;
export const MAX_TEXT_SIZE = 30;

/**
 * Merge a partial, untrusted update onto `base`.
 *
 * Every field is validated and out-of-range or unknown values are ignored
 * rather than rejected: a client one version ahead sending a field this relay
 * has never heard of should not fail the whole write, and a text size of 400
 * should not produce a watch screen showing one letter.
 */
export function mergeSettings(base: Settings, update: unknown): Settings {
  if (typeof update !== "object" || update === null) return base;
  const patch = update as Record<string, unknown>;
  const merged: Settings = { ...base };

  if (typeof patch.captionTextSize === "number" && Number.isFinite(patch.captionTextSize)) {
    merged.captionTextSize = Math.min(
      MAX_TEXT_SIZE,
      Math.max(MIN_TEXT_SIZE, Math.round(patch.captionTextSize)),
    );
  }
  if (typeof patch.autoOpenPhoneAudio === "boolean") {
    merged.autoOpenPhoneAudio = patch.autoOpenPhoneAudio;
  }
  if (typeof patch.saveTranscripts === "boolean") {
    merged.saveTranscripts = patch.saveTranscripts;
  }
  if (PROVIDER_NAMES.includes(patch.provider as ProviderName)) {
    merged.provider = patch.provider as ProviderName;
  }
  return merged;
}
