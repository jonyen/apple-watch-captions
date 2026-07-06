import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { LiveTranscriptionEvents } from "@deepgram/sdk";
import {
  DeepgramProvider,
  DeepgramLike,
  LiveConnectionLike,
  KEEPALIVE_INTERVAL_MS,
  KEEPALIVE_MESSAGE,
  MAX_RECONNECT_ATTEMPTS,
} from "./deepgramProvider";

/** Minimal stand-in for a Deepgram live connection. */
class FakeLiveConnection extends EventEmitter implements LiveConnectionLike {
  sent: (Buffer | string)[] = [];
  closeRequested = false;
  send(data: Buffer | string) {
    this.sent.push(data);
  }
  requestClose() {
    this.closeRequested = true;
  }
  on(event: string, cb: (...args: any[]) => void) {
    super.on(event, cb);
    return this;
  }
  sentAudio(): string {
    return Buffer.concat(this.sent.filter((d): d is Buffer => Buffer.isBuffer(d))).toString();
  }
  keepAlives(): number {
    return this.sent.filter((d) => d === KEEPALIVE_MESSAGE).length;
  }
}

/** Deepgram client stand-in that mints a fresh fake connection per live() call. */
function fakeDeepgram(): { client: DeepgramLike; conns: FakeLiveConnection[] } {
  const conns: FakeLiveConnection[] = [];
  const client: DeepgramLike = {
    listen: {
      live: () => {
        const conn = new FakeLiveConnection();
        conns.push(conn);
        return conn;
      },
    },
  };
  return { client, conns };
}

function transcriptPayload(text: string, isFinal: boolean) {
  return { is_final: isFinal, channel: { alternatives: [{ transcript: text }] } };
}

describe("DeepgramProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("fires onReady when the connection opens", () => {
    const { client, conns } = fakeDeepgram();
    const p = new DeepgramProvider(client);
    let ready = false;
    p.onReady(() => (ready = true));
    conns[0].emit(LiveTranscriptionEvents.Open);
    expect(ready).toBe(true);
  });

  it("forwards audio once the connection is open", () => {
    const { client, conns } = fakeDeepgram();
    const p = new DeepgramProvider(client);
    conns[0].emit(LiveTranscriptionEvents.Open);
    p.sendAudio(Buffer.from("pcm"));
    expect(conns[0].sentAudio()).toBe("pcm");
  });

  it("buffers audio sent before open and flushes it on open", () => {
    const { client, conns } = fakeDeepgram();
    const p = new DeepgramProvider(client);
    p.sendAudio(Buffer.from("early"));
    expect(conns[0].sentAudio()).toBe("");
    conns[0].emit(LiveTranscriptionEvents.Open);
    expect(conns[0].sentAudio()).toBe("early");
  });

  it("maps Deepgram results to transcripts", () => {
    const { client, conns } = fakeDeepgram();
    const p = new DeepgramProvider(client);
    const got: string[] = [];
    p.onTranscript((t) => got.push(`${t.text}:${t.isFinal}`));
    conns[0].emit(LiveTranscriptionEvents.Transcript, transcriptPayload("hello", false));
    conns[0].emit(LiveTranscriptionEvents.Transcript, transcriptPayload("hello world", true));
    expect(got).toEqual(["hello:false", "hello world:true"]);
  });

  it("sends KeepAlive messages while the connection is open", () => {
    const { client, conns } = fakeDeepgram();
    new DeepgramProvider(client);
    conns[0].emit(LiveTranscriptionEvents.Open);
    vi.advanceTimersByTime(KEEPALIVE_INTERVAL_MS * 3);
    expect(conns[0].keepAlives()).toBe(3);
  });

  it("reconnects on close instead of surfacing an error", () => {
    const { client, conns } = fakeDeepgram();
    const p = new DeepgramProvider(client);
    let error = "";
    p.onError((m) => (error = m));
    conns[0].emit(LiveTranscriptionEvents.Open);
    conns[0].emit(LiveTranscriptionEvents.Close, { code: 1011 });
    vi.runOnlyPendingTimers(); // reconnect backoff
    expect(error).toBe("");
    expect(conns.length).toBe(2);
  });

  it("buffers audio during an outage and replays it on the new connection", () => {
    const { client, conns } = fakeDeepgram();
    const p = new DeepgramProvider(client);
    conns[0].emit(LiveTranscriptionEvents.Open);
    conns[0].emit(LiveTranscriptionEvents.Close);
    p.sendAudio(Buffer.from("while-down"));
    vi.runOnlyPendingTimers();
    conns[1].emit(LiveTranscriptionEvents.Open);
    expect(conns[1].sentAudio()).toBe("while-down");
  });

  it("fires onReady only once across reconnects", () => {
    const { client, conns } = fakeDeepgram();
    const p = new DeepgramProvider(client);
    let readyCount = 0;
    p.onReady(() => readyCount++);
    conns[0].emit(LiveTranscriptionEvents.Open);
    conns[0].emit(LiveTranscriptionEvents.Close);
    vi.runOnlyPendingTimers();
    conns[1].emit(LiveTranscriptionEvents.Open);
    expect(readyCount).toBe(1);
  });

  it("ignores events from a stale connection after reconnect", () => {
    const { client, conns } = fakeDeepgram();
    const p = new DeepgramProvider(client);
    const got: string[] = [];
    p.onTranscript((t) => got.push(t.text));
    conns[0].emit(LiveTranscriptionEvents.Open);
    conns[0].emit(LiveTranscriptionEvents.Close);
    vi.runOnlyPendingTimers();
    conns[0].emit(LiveTranscriptionEvents.Transcript, transcriptPayload("stale", true));
    expect(got).toEqual([]);
  });

  it("schedules a single reconnect when Error and Close both fire", () => {
    const { client, conns } = fakeDeepgram();
    new DeepgramProvider(client);
    conns[0].emit(LiveTranscriptionEvents.Open);
    conns[0].emit(LiveTranscriptionEvents.Error, { message: "boom" });
    conns[0].emit(LiveTranscriptionEvents.Close);
    vi.runOnlyPendingTimers();
    expect(conns.length).toBe(2);
  });

  it("surfaces an error after repeated consecutive failures", () => {
    const { client, conns } = fakeDeepgram();
    const p = new DeepgramProvider(client);
    let error = "";
    p.onError((m) => (error = m));
    conns[0].emit(LiveTranscriptionEvents.Open);
    // Each new connection dies without ever opening.
    for (let i = 0; i < MAX_RECONNECT_ATTEMPTS + 1; i++) {
      conns[conns.length - 1].emit(LiveTranscriptionEvents.Close);
      vi.runOnlyPendingTimers();
    }
    expect(error).toBe("transcription connection lost");
  });

  it("recovers the failure budget once a reconnect succeeds", () => {
    const { client, conns } = fakeDeepgram();
    const p = new DeepgramProvider(client);
    let error = "";
    p.onError((m) => (error = m));
    conns[0].emit(LiveTranscriptionEvents.Open);
    for (let i = 0; i < MAX_RECONNECT_ATTEMPTS; i++) {
      conns[conns.length - 1].emit(LiveTranscriptionEvents.Close);
      vi.runOnlyPendingTimers();
    }
    conns[conns.length - 1].emit(LiveTranscriptionEvents.Open); // recovery
    conns[conns.length - 1].emit(LiveTranscriptionEvents.Close); // one more drop
    vi.runOnlyPendingTimers();
    expect(error).toBe("");
  });

  it("does not reconnect after close() and requests close on the connection", () => {
    const { client, conns } = fakeDeepgram();
    const p = new DeepgramProvider(client);
    conns[0].emit(LiveTranscriptionEvents.Open);
    p.close();
    expect(conns[0].closeRequested).toBe(true);
    conns[0].emit(LiveTranscriptionEvents.Close);
    vi.runOnlyPendingTimers();
    expect(conns.length).toBe(1);
  });

  it("stops KeepAlives after close()", () => {
    const { client, conns } = fakeDeepgram();
    const p = new DeepgramProvider(client);
    conns[0].emit(LiveTranscriptionEvents.Open);
    p.close();
    vi.advanceTimersByTime(KEEPALIVE_INTERVAL_MS * 3);
    expect(conns[0].keepAlives()).toBe(0);
  });

  it("passes option overrides to the live connection", () => {
    const opts: Record<string, unknown>[] = [];
    const client: DeepgramLike = {
      listen: {
        live: (o?: Record<string, unknown>) => {
          opts.push(o ?? {});
          return new FakeLiveConnection();
        },
      },
    };
    new DeepgramProvider(client, { channels: 2, multichannel: true });
    expect(opts[0]).toMatchObject({ channels: 2, multichannel: true, model: "nova-2" });
  });

  it("maps channel_index onto transcripts", () => {
    const { client, conns } = fakeDeepgram();
    const p = new DeepgramProvider(client);
    const got: (number | undefined)[] = [];
    p.onTranscript((t) => got.push(t.channel));
    conns[0].emit(LiveTranscriptionEvents.Transcript, {
      is_final: true,
      channel_index: [1, 2],
      channel: { alternatives: [{ transcript: "hi" }] },
    });
    conns[0].emit(LiveTranscriptionEvents.Transcript, transcriptPayload("mono", true));
    expect(got).toEqual([1, undefined]);
  });
});
