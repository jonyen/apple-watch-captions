import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import {
  AppleTranscriptionProvider,
  WebSocketLike,
  APPLE_DEFAULT_URL,
  FINISH_TIMEOUT_MS,
} from "./appleProvider";
import { Transcript } from "./transcriptionProvider";

/** Minimal stand-in for the sidecar's WebSocket connection. */
class FakeSocket extends EventEmitter implements WebSocketLike {
  sent: (Buffer | string)[] = [];
  closeCalled = false;
  readyState = 0;
  send(data: Buffer | string) {
    this.sent.push(data);
  }
  close() {
    this.closeCalled = true;
  }
  on(event: string, cb: (...args: any[]) => void) {
    super.on(event, cb);
    return this;
  }
  sentText(): any[] {
    return this.sent.filter((d) => typeof d === "string").map((d) => JSON.parse(d as string));
  }
  sentAudio(): string {
    return Buffer.concat(this.sent.filter((d): d is Buffer => Buffer.isBuffer(d))).toString();
  }
}

function fakeApple(opts: Record<string, unknown> = {}) {
  const sockets: FakeSocket[] = [];
  const wsFactory = (_url: string): WebSocketLike => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  };
  const p = new AppleTranscriptionProvider(APPLE_DEFAULT_URL, { ...opts, wsFactory });
  return { p, socket: sockets[0] };
}

describe("AppleTranscriptionProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("buffers audio sent before open and flushes it after the config frame, in order", () => {
    const { p, socket } = fakeApple();
    p.sendAudio(Buffer.from("a"));
    p.sendAudio(Buffer.from("b"));
    expect(socket.sentAudio()).toBe("");
    socket.emit("open");
    expect(socket.sentText()).toEqual([{ config: {} }]);
    expect(socket.sentAudio()).toBe("ab");
    // config frame must be the very first frame sent overall.
    expect(typeof socket.sent[0]).toBe("string");
  });

  it("sends locale and format in the config frame when provided", () => {
    const { socket } = fakeApple({ locale: "en-US", format: "pcm16k" });
    socket.emit("open");
    expect(socket.sentText()).toEqual([{ config: { locale: "en-US", format: "pcm16k" } }]);
  });

  it("forwards audio directly once open", () => {
    const { p, socket } = fakeApple();
    socket.emit("open");
    p.sendAudio(Buffer.from("pcm"));
    expect(socket.sentAudio()).toBe("pcm");
  });

  it("fires onReady on {ready:true}", () => {
    const { p, socket } = fakeApple();
    let ready = false;
    p.onReady(() => (ready = true));
    socket.emit("message", JSON.stringify({ ready: true }));
    expect(ready).toBe(true);
  });

  it("maps text/isFinal messages to transcripts", () => {
    const { p, socket } = fakeApple();
    const got: Transcript[] = [];
    p.onTranscript((t) => got.push(t));
    socket.emit("message", JSON.stringify({ text: "hi", isFinal: false }));
    socket.emit("message", JSON.stringify({ text: "hi there", isFinal: true }));
    expect(got).toEqual([
      { text: "hi", isFinal: false },
      { text: "hi there", isFinal: true },
    ]);
  });

  it("passes cumulative partials through as-is without diffing", () => {
    const { p, socket } = fakeApple();
    const got: string[] = [];
    p.onTranscript((t) => got.push(t.text));
    socket.emit("message", JSON.stringify({ text: "the", isFinal: false }));
    socket.emit("message", JSON.stringify({ text: "the cat", isFinal: false }));
    socket.emit("message", JSON.stringify({ text: "the cat sat", isFinal: false }));
    expect(got).toEqual(["the", "the cat", "the cat sat"]);
  });

  it("fires onError on {error:...}", () => {
    const { p, socket } = fakeApple();
    let error = "";
    p.onError((m) => (error = m));
    socket.emit("message", JSON.stringify({ error: "boom" }));
    expect(error).toBe("boom");
  });

  it("ignores malformed JSON frames", () => {
    const { p, socket } = fakeApple();
    let called = false;
    p.onTranscript(() => (called = true));
    p.onReady(() => (called = true));
    p.onError(() => (called = true));
    socket.emit("message", "{not json");
    expect(called).toBe(false);
  });

  it("close() sends finish and waits for done before closing", () => {
    const { p, socket } = fakeApple();
    socket.emit("open");
    p.close();
    expect(socket.sentText()).toContainEqual({ finish: true });
    expect(socket.closeCalled).toBe(false);
    socket.emit("message", JSON.stringify({ done: true }));
    expect(socket.closeCalled).toBe(true);
  });

  it("close()'s returned promise resolves only once done arrives, not before", async () => {
    const { p, socket } = fakeApple();
    socket.emit("open");
    let resolved = false;
    p.close().then(() => (resolved = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);
    socket.emit("message", JSON.stringify({ done: true }));
    await Promise.resolve();
    expect(resolved).toBe(true);
  });

  it("close()'s returned promise resolves after the finish timeout when done never arrives", async () => {
    const { p, socket } = fakeApple();
    socket.emit("open");
    let resolved = false;
    p.close().then(() => (resolved = true));
    await vi.advanceTimersByTimeAsync(FINISH_TIMEOUT_MS - 1);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
    expect(socket.closeCalled).toBe(true);
  });

  it("a second close() call returns the same promise instead of resending finish", async () => {
    const { p, socket } = fakeApple();
    socket.emit("open");
    const first = p.close();
    const second = p.close();
    expect(second).toBe(first);
    expect(socket.sentText().filter((f) => f.finish).length).toBe(1);
    socket.emit("message", JSON.stringify({ done: true }));
    await first;
  });

  it("forwards transcripts that arrive between finish and done", () => {
    const { p, socket } = fakeApple();
    socket.emit("open");
    const got: string[] = [];
    p.onTranscript((t) => got.push(t.text));
    p.close();
    socket.emit("message", JSON.stringify({ text: "final result", isFinal: true }));
    socket.emit("message", JSON.stringify({ done: true }));
    expect(got).toEqual(["final result"]);
    expect(socket.closeCalled).toBe(true);
  });

  it("emits no error when the server closes right after finish", () => {
    const { p, socket } = fakeApple();
    socket.emit("open");
    let error = "";
    p.onError((m) => (error = m));
    p.close();
    socket.emit("message", JSON.stringify({ done: true }));
    socket.emit("close"); // server tears the socket down after sending done
    expect(error).toBe("");
  });

  it("closes anyway after the finish timeout if done never arrives", () => {
    const { p, socket } = fakeApple();
    socket.emit("open");
    let error = "";
    p.onError((m) => (error = m));
    p.close();
    expect(socket.closeCalled).toBe(false);
    vi.advanceTimersByTime(FINISH_TIMEOUT_MS);
    expect(socket.closeCalled).toBe(true);
    socket.emit("close");
    expect(error).toBe("");
  });

  it("honors an injected finish timeout for tests", () => {
    const sockets: FakeSocket[] = [];
    const wsFactory = (_url: string): WebSocketLike => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    };
    const p = new AppleTranscriptionProvider(APPLE_DEFAULT_URL, {
      wsFactory,
      finishTimeoutMs: 50,
    });
    const socket = sockets[0];
    socket.emit("open");
    p.close();
    vi.advanceTimersByTime(49);
    expect(socket.closeCalled).toBe(false);
    vi.advanceTimersByTime(1);
    expect(socket.closeCalled).toBe(true);
  });

  it("fires onError('transcriber connection lost') on an unexpected close", () => {
    const { p, socket } = fakeApple();
    let error = "";
    p.onError((m) => (error = m));
    socket.emit("open");
    socket.emit("close");
    expect(error).toBe("transcriber connection lost");
  });

  it("does not fire onError for a close before open completes but after finish requested", () => {
    // Sanity: close() before open never sent finish, so no wait — just closes.
    const { p, socket } = fakeApple();
    let error = "";
    p.onError((m) => (error = m));
    p.close();
    expect(socket.closeCalled).toBe(true);
    socket.emit("close");
    expect(error).toBe("");
  });

  it("drops audio sent after close()", () => {
    const { p, socket } = fakeApple();
    socket.emit("open");
    p.close();
    p.sendAudio(Buffer.from("late"));
    expect(socket.sentAudio()).toBe("");
  });
});
