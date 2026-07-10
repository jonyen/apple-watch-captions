import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import {
  AssemblyAIProvider,
  ASSEMBLYAI_STREAMING_URL,
  ASSEMBLYAI_TERMINATE,
} from "./assemblyaiProvider";
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
}

function makeProvider() {
  const socket = new FakeSocket();
  const provider = new AssemblyAIProvider("test-key", (url, headers) => {
    socket.url = url;
    socket.headers = headers;
    return socket;
  });
  return { provider, socket };
}

describe("AssemblyAIProvider", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("connects with the API key to the v3 streaming endpoint", () => {
    const { socket } = makeProvider();
    expect(socket.url).toBe(ASSEMBLYAI_STREAMING_URL);
    expect(socket.headers.Authorization).toBe("test-key");
  });

  it("fires ready on open and forwards raw audio", () => {
    const { provider, socket } = makeProvider();
    let ready = false;
    provider.onReady(() => (ready = true));
    socket.emit("open");
    expect(ready).toBe(true);
    provider.sendAudio(Buffer.from("pcm"));
    expect(socket.sent).toEqual([Buffer.from("pcm")]);
  });

  it("buffers audio until the socket opens", () => {
    const { provider, socket } = makeProvider();
    provider.sendAudio(Buffer.from("early"));
    expect(socket.sent).toHaveLength(0);
    socket.emit("open");
    expect(socket.sent).toEqual([Buffer.from("early")]);
  });

  it("maps Turn messages to partials and formatted end-of-turn to finals", () => {
    const { provider, socket } = makeProvider();
    const got: Transcript[] = [];
    provider.onTranscript((t) => got.push(t));
    socket.emit("open");
    socket.emit("message", JSON.stringify({ type: "Turn", transcript: "hello", end_of_turn: false }));
    socket.emit(
      "message",
      JSON.stringify({ type: "Turn", transcript: "hello there", end_of_turn: true, turn_is_formatted: false }),
    );
    socket.emit(
      "message",
      JSON.stringify({ type: "Turn", transcript: "Hello there.", end_of_turn: true, turn_is_formatted: true }),
    );
    expect(got).toEqual([
      { text: "hello", isFinal: false },
      { text: "hello there", isFinal: false },
      { text: "Hello there.", isFinal: true },
    ]);
  });

  it("ignores empty transcripts", () => {
    const { provider, socket } = makeProvider();
    const got: Transcript[] = [];
    provider.onTranscript((t) => got.push(t));
    socket.emit("open");
    socket.emit("message", JSON.stringify({ type: "Turn", transcript: "", end_of_turn: false }));
    expect(got).toEqual([]);
  });

  it("surfaces API error messages", () => {
    const { provider, socket } = makeProvider();
    const errors: string[] = [];
    provider.onError((m) => errors.push(m));
    socket.emit("message", JSON.stringify({ type: "Error", error: "over quota" }));
    expect(errors).toEqual(["over quota"]);
  });

  it("terminates the session on close and suppresses the close error", () => {
    const { provider, socket } = makeProvider();
    const errors: string[] = [];
    provider.onError((m) => errors.push(m));
    socket.emit("open");
    provider.close();
    expect(socket.sent).toContain(ASSEMBLYAI_TERMINATE);
    expect(socket.closed).toBe(true);
    socket.emit("close");
    expect(errors).toEqual([]);
  });

  it("reports an unexpected close as an error", () => {
    const { provider, socket } = makeProvider();
    const errors: string[] = [];
    provider.onError((m) => errors.push(m));
    socket.emit("close");
    expect(errors).toEqual(["AssemblyAI connection closed"]);
  });
});
