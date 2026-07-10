import { TranscriptionProvider, Transcript } from "./transcriptionProvider";
import {
  StreamingSocketLike,
  StreamingSocketFactory,
  defaultSocketFactory,
} from "./streamingSocket";

export const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime?intent=transcription";
export const OPENAI_TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";

/** Session config sent right after the socket opens. */
export const OPENAI_SESSION_UPDATE = {
  type: "transcription_session.update",
  session: {
    input_audio_format: "pcm16",
    input_audio_transcription: { model: OPENAI_TRANSCRIBE_MODEL },
    turn_detection: { type: "server_vad" },
  },
};

/** Cap on audio buffered before the socket opens (~16s of 16kHz mono Int16). */
const MAX_BUFFERED_BYTES = 512 * 1024;

/**
 * OpenAI Realtime transcription (mono 24 kHz pcm16). Incoming audio is 16 kHz,
 * so chunks are upsampled before base64-framing. Partials are the
 * accumulated `…transcription.delta` events for the in-progress item;
 * `…transcription.completed` finalizes it.
 */
export class OpenAIProvider implements TranscriptionProvider {
  private socket: StreamingSocketLike;
  private transcriptHandler: (t: Transcript) => void = () => {};
  private readyHandler: () => void = () => {};
  private errorHandler: (message: string) => void = () => {};

  private open = false;
  private closed = false;
  private buffered: Buffer[] = [];
  private bufferedBytes = 0;
  private partial = "";

  constructor(apiKey: string, socketFactory: StreamingSocketFactory = defaultSocketFactory) {
    this.socket = socketFactory(OPENAI_REALTIME_URL, {
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Beta": "realtime=v1",
    });

    this.socket.on("open", () => {
      if (this.closed) return;
      this.open = true;
      this.socket.send(JSON.stringify(OPENAI_SESSION_UPDATE));
      for (const chunk of this.buffered) this.sendFrame(chunk);
      this.buffered = [];
      this.bufferedBytes = 0;
      this.readyHandler();
    });

    this.socket.on("message", (data: Buffer | string) => {
      let event: any;
      try {
        event = JSON.parse(data.toString());
      } catch {
        return;
      }
      switch (event?.type) {
        case "conversation.item.input_audio_transcription.delta": {
          this.partial += String(event.delta ?? "");
          if (this.partial.length > 0) {
            this.transcriptHandler({ text: this.partial, isFinal: false });
          }
          break;
        }
        case "conversation.item.input_audio_transcription.completed": {
          this.partial = "";
          const text = String(event.transcript ?? "").trim();
          if (text.length > 0) this.transcriptHandler({ text, isFinal: true });
          break;
        }
        case "error": {
          const message = event?.error?.message ?? "OpenAI transcription error";
          console.error("openai error:", message);
          this.errorHandler(String(message));
          break;
        }
      }
    });

    this.socket.on("error", (err: any) => {
      if (this.closed) return;
      console.error("openai socket error:", err?.message ?? err);
      this.errorHandler("OpenAI connection error");
    });

    this.socket.on("close", () => {
      if (this.closed) return;
      this.open = false;
      this.errorHandler("OpenAI connection closed");
    });
  }

  onTranscript(handler: (t: Transcript) => void): void {
    this.transcriptHandler = handler;
  }
  onReady(handler: () => void): void {
    this.readyHandler = handler;
  }
  onError(handler: (message: string) => void): void {
    this.errorHandler = handler;
  }

  sendAudio(chunk: Buffer): void {
    if (this.closed) return;
    if (!this.open) {
      this.buffered.push(chunk);
      this.bufferedBytes += chunk.length;
      while (this.bufferedBytes > MAX_BUFFERED_BYTES && this.buffered.length > 0) {
        this.bufferedBytes -= this.buffered.shift()!.length;
      }
      return;
    }
    this.sendFrame(chunk);
  }

  private sendFrame(chunk: Buffer): void {
    const audio = upsample16kTo24k(chunk).toString("base64");
    this.socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio }));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.close();
  }
}

/**
 * Linear-interpolation resample of little-endian Int16 mono PCM from 16 kHz
 * to the 24 kHz the Realtime API expects (3 output samples per 2 input).
 * Chunk edges aren't stitched; the sub-sample discontinuity is inaudible.
 */
export function upsample16kTo24k(chunk: Buffer): Buffer {
  const samples = Math.floor(chunk.length / 2);
  if (samples === 0) return Buffer.alloc(0);
  const outSamples = Math.floor((samples * 3) / 2);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const pos = (i * 2) / 3;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = chunk.readInt16LE(i0 * 2);
    const b = i0 + 1 < samples ? chunk.readInt16LE((i0 + 1) * 2) : a;
    out.writeInt16LE(Math.round(a + (b - a) * frac), i * 2);
  }
  return out;
}
