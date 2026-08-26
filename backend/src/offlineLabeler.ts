import { readFileSync } from "fs";
import { TranscriptionProvider } from "./transcriptionProvider";

/** This relay only ever writes 44-byte PCM WAV headers (see trainingCapture.ts). */
const WAV_HEADER_BYTES = 44;
/** Chunk size PCM is pushed to the provider in — arbitrary; not paced to real time. */
const CHUNK_BYTES = 32 * 1024;
/**
 * How long to wait for `{"ready":true}` before giving up on labeling this
 * clip. Generous relative to a local sidecar's real startup time; exists
 * only so a hung or missing sidecar can't leave `archiveFinalize` — and
 * thus `SessionStore.stop`/`reapIdle`, which await it — waiting forever.
 */
export const READY_TIMEOUT_MS = 10_000;

/**
 * Builds the offline labeler `TrainingCapture.archiveFinalize` runs an
 * archived session's audio through: opens a fresh provider (in production
 * always the Apple sidecar — `createProvider` is expected to be pinned to
 * `{ provider: "apple" }` by the caller), streams the WAV's PCM as fast as
 * it can be sent rather than paced to real time (nothing downstream needs to
 * hear it live), and resolves with every final transcript it produced once
 * the provider's own bounded graceful close is over.
 *
 * Audio is held until `{"ready":true}` arrives, not merely until the socket
 * opens: the sidecar protocol sends `ready` "once the transcriber is set up
 * and audio may flow" (imac-relay-local-stt design doc) — audio sent before
 * that, even over an already-open socket, can arrive before the recognizer
 * is actually listening and be silently dropped, producing zero labels for
 * a real recording. `READY_TIMEOUT_MS` bounds that wait so a sidecar that
 * never becomes ready still fails the promise rather than hanging it.
 *
 * An error from the provider (or the ready timeout) rejects the returned
 * promise; the caller (`archiveFinalize`) is responsible for keeping the
 * audio and noting labeling failed rather than losing anything.
 */
export function createOfflineLabeler(
  createProvider: () => TranscriptionProvider,
  opts: { readyTimeoutMs?: number } = {},
): (wavPath: string) => Promise<string[]> {
  const readyTimeoutMs = opts.readyTimeoutMs ?? READY_TIMEOUT_MS;
  return function transcribeOffline(wavPath: string): Promise<string[]> {
    return new Promise<string[]>((resolve, reject) => {
      let pcm: Buffer;
      try {
        pcm = readFileSync(wavPath).subarray(WAV_HEADER_BYTES);
      } catch (err) {
        reject(err);
        return;
      }

      const provider = createProvider();
      const finals: string[] = [];
      let settled = false;

      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(readyTimer);
        reject(err);
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        clearTimeout(readyTimer);
        resolve(finals);
      };

      const readyTimer = setTimeout(() => {
        fail(new Error("offline labeling timed out waiting for the provider to become ready"));
      }, readyTimeoutMs);

      provider.onTranscript((t) => {
        if (t.isFinal && t.text.length > 0) finals.push(t.text);
      });
      provider.onError((message) => fail(new Error(message)));

      // Send the whole clip in one burst once ready — this is offline
      // labeling, not a live session, so nothing needs real-time pacing —
      // and finish immediately after; any transcript the recognizer
      // produces before `done` still gets forwarded (per the sidecar
      // protocol), and `close()`'s own bounded wait covers the rest.
      provider.onReady(() => {
        if (settled) return;
        clearTimeout(readyTimer);
        for (let offset = 0; offset < pcm.length; offset += CHUNK_BYTES) {
          provider.sendAudio(pcm.subarray(offset, offset + CHUNK_BYTES));
        }
        provider.close().then(succeed).catch((err) => fail(err));
      });
    });
  };
}
