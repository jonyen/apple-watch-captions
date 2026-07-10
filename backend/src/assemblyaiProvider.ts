import { TranscriptionProvider, Transcript } from "./transcriptionProvider";
import {
  StreamingSocketLike,
  StreamingSocketFactory,
  defaultSocketFactory,
} from "./streamingSocket";

export const ASSEMBLYAI_STREAMING_URL =
  "wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&format_turns=true";

export const ASSEMBLYAI_TERMINATE = JSON.stringify({ type: "Terminate" });

/** Cap on audio buffered before the socket opens (~16s of 16kHz mono Int16). */
const MAX_BUFFERED_BYTES = 512 * 1024;

/**
 * AssemblyAI Universal-Streaming v3 (mono 16 kHz pcm16, sent as raw binary).
 * A Turn message with `end_of_turn: false` is a partial; with `format_turns`
 * on, the formatted `end_of_turn: true` + `turn_is_formatted: true` message
 * is the final (the unformatted end-of-turn that precedes it is treated as a
 * partial so the final isn't emitted twice).
 */
export class AssemblyAIProvider implements TranscriptionProvider {
  private socket: StreamingSocketLike;
  private transcriptHandler: (t: Transcript) => void = () => {};
  private readyHandler: () => void = () => {};
  private errorHandler: (message: string) => void = () => {};

  private open = false;
  private closed = false;
  private buffered: Buffer[] = [];
  private bufferedBytes = 0;

  constructor(apiKey: string, socketFactory: StreamingSocketFactory = defaultSocketFactory) {
    this.socket = socketFactory(ASSEMBLYAI_STREAMING_URL, { Authorization: apiKey });

    this.socket.on("open", () => {
      if (this.closed) return;
      this.open = true;
      for (const chunk of this.buffered) this.socket.send(chunk);
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
        case "Turn": {
          const text = String(event.transcript ?? "").trim();
          if (text.length === 0) return;
          const isFinal = Boolean(event.end_of_turn) && Boolean(event.turn_is_formatted);
          this.transcriptHandler({ text, isFinal });
          break;
        }
        case "Error": {
          const message = event?.error ?? "AssemblyAI transcription error";
          console.error("assemblyai error:", message);
          this.errorHandler(String(message));
          break;
        }
      }
    });

    this.socket.on("error", (err: any) => {
      if (this.closed) return;
      console.error("assemblyai socket error:", err?.message ?? err);
      this.errorHandler("AssemblyAI connection error");
    });

    this.socket.on("close", () => {
      if (this.closed) return;
      this.open = false;
      this.errorHandler("AssemblyAI connection closed");
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
    this.socket.send(chunk);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.open) this.socket.send(ASSEMBLYAI_TERMINATE);
    this.socket.close();
  }
}
