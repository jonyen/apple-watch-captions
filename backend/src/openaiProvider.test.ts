import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import {
  OpenAIProvider,
  OPENAI_REALTIME_URL,
  OPENAI_SESSION_UPDATE,
  upsample16kTo24k,
} from "./openaiProvider";
import { StreamingSocketLike } from "./streamingSocket";
import { Transcript } from "./transcriptionProvider";

class FakeSocket extends EventEmitter implements StreamingSocketLike {
  sent: (Buffer | string)[] = [];
  closed = false;
  url = "";
  headers: Record<string, string> = {};
  send(data: Buffer | string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  on(event: string, cb: (...args: any[]) => void) {
    super.on(event, cb);
    return this;
  }
  jsonSent(): any[] {
    return this.sent.filter((d): d is string => typeof d === "string").map((s) => JSON.parse(s));
  }
}

function makeProvider() {
  const socket = new FakeSocket();
  const provider = new OpenAIProvider("test-key", (url, headers) => {
    socket.url = url;
    socket.headers = headers;
    return socket;
  });
  return { provider, socket };
}

function pcm(...samples: number[]): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => buf.writeInt16LE(s, i * 2));
  return buf;
}

describe("OpenAIProvider", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("connects with bearer auth to the realtime transcription endpoint", () => {
    const { socket } = makeProvider();
    expect(socket.url).toBe(OPENAI_REALTIME_URL);
    expect(socket.headers.Authorization).toBe("Bearer test-key");
  });

  it("sends the session config and fires ready on open", () => {
    const { provider, socket } = makeProvider();
    let ready = false;
    provider.onReady(() => (ready = true));
    socket.emit("open");
    expect(ready).toBe(true);
    expect(socket.jsonSent()[0]).toEqual(OPENAI_SESSION_UPDATE);
  });

  it("buffers audio until open, then sends base64 append frames", () => {
    const { provider, socket } = makeProvider();
    provider.sendAudio(pcm(1000, 2000));
    expect(socket.sent).toHaveLength(0);
    socket.emit("open");
    const frames = socket.jsonSent().filter((m) => m.type === "input_audio_buffer.append");
    expect(frames).toHaveLength(1);
    const audio = Buffer.from(frames[0].audio, "base64");
    expect(audio.equals(upsample16kTo24k(pcm(1000, 2000)))).toBe(true);
  });

  it("accumulates deltas into partials and emits completed as final", () => {
    const { provider, socket } = makeProvider();
    const got: Transcript[] = [];
    provider.onTranscript((t) => got.push(t));
    socket.emit("open");
    socket.emit(
      "message",
      JSON.stringify({ type: "conversation.item.input_audio_transcription.delta", delta: "Hel" }),
    );
    socket.emit(
      "message",
      JSON.stringify({ type: "conversation.item.input_audio_transcription.delta", delta: "lo" }),
    );
    socket.emit(
      "message",
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "Hello.",
      }),
    );
    expect(got).toEqual([
      { text: "Hel", isFinal: false },
      { text: "Hello", isFinal: false },
      { text: "Hello.", isFinal: true },
    ]);
  });

  it("resets the partial after a completed transcript", () => {
    const { provider, socket } = makeProvider();
    const got: Transcript[] = [];
    provider.onTranscript((t) => got.push(t));
    socket.emit("open");
    socket.emit(
      "message",
      JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "One." }),
    );
    socket.emit(
      "message",
      JSON.stringify({ type: "conversation.item.input_audio_transcription.delta", delta: "Two" }),
    );
    expect(got).toEqual([
      { text: "One.", isFinal: true },
      { text: "Two", isFinal: false },
    ]);
  });

  it("surfaces API error events", () => {
    const { provider, socket } = makeProvider();
    const errors: string[] = [];
    provider.onError((m) => errors.push(m));
    socket.emit("message", JSON.stringify({ type: "error", error: { message: "bad session" } }));
    expect(errors).toEqual(["bad session"]);
  });

  it("reports an unexpected close as an error, but not one it initiated", () => {
    const first = makeProvider();
    const errors: string[] = [];
    first.provider.onError((m) => errors.push(m));
    first.socket.emit("close");
    expect(errors).toEqual(["OpenAI connection closed"]);

    const second = makeProvider();
    const secondErrors: string[] = [];
    second.provider.onError((m) => secondErrors.push(m));
    second.provider.close();
    second.socket.emit("close");
    expect(second.socket.closed).toBe(true);
    expect(secondErrors).toEqual([]);
  });
});

describe("upsample16kTo24k", () => {
  it("produces 3 output samples per 2 input samples", () => {
    expect(upsample16kTo24k(pcm(0, 0, 0, 0)).length / 2).toBe(6);
  });

  it("interpolates linearly between input samples", () => {
    const out = upsample16kTo24k(pcm(0, 300));
    const samples = [out.readInt16LE(0), out.readInt16LE(2), out.readInt16LE(4)];
    expect(samples).toEqual([0, 200, 300]);
  });

  it("handles empty input", () => {
    expect(upsample16kTo24k(Buffer.alloc(0)).length).toBe(0);
  });
});
