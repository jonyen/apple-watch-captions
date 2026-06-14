import { describe, it, expect } from "vitest";
import { EventEmitter } from "events";
import { LiveTranscriptionEvents } from "@deepgram/sdk";
import { DeepgramProvider, DeepgramLike, LiveConnectionLike } from "./deepgramProvider";

/** Minimal stand-in for a Deepgram live connection. */
class FakeLiveConnection extends EventEmitter implements LiveConnectionLike {
  sent: Buffer[] = [];
  closeRequested = false;
  send(data: Buffer) {
    this.sent.push(data);
  }
  requestClose() {
    this.closeRequested = true;
  }
  on(event: string, cb: (...args: any[]) => void) {
    super.on(event, cb);
    return this;
  }
}

/** Stand-in for the Deepgram client whose listen.live() returns our fake. */
function fakeDeepgram(conn: FakeLiveConnection): DeepgramLike {
  return { listen: { live: () => conn } };
}

function transcriptPayload(text: string, isFinal: boolean) {
  return { is_final: isFinal, channel: { alternatives: [{ transcript: text }] } };
}

describe("DeepgramProvider", () => {
  it("fires onReady when the connection opens", () => {
    const conn = new FakeLiveConnection();
    const p = new DeepgramProvider(fakeDeepgram(conn));
    let ready = false;
    p.onReady(() => (ready = true));
    conn.emit(LiveTranscriptionEvents.Open);
    expect(ready).toBe(true);
  });

  it("forwards audio to the live connection", () => {
    const conn = new FakeLiveConnection();
    const p = new DeepgramProvider(fakeDeepgram(conn));
    p.sendAudio(Buffer.from("pcm"));
    expect(Buffer.concat(conn.sent).toString()).toBe("pcm");
  });

  it("maps Deepgram results to transcripts", () => {
    const conn = new FakeLiveConnection();
    const p = new DeepgramProvider(fakeDeepgram(conn));
    const got: string[] = [];
    p.onTranscript((t) => got.push(`${t.text}:${t.isFinal}`));
    conn.emit(LiveTranscriptionEvents.Transcript, transcriptPayload("hello", false));
    conn.emit(LiveTranscriptionEvents.Transcript, transcriptPayload("hello world", true));
    expect(got).toEqual(["hello:false", "hello world:true"]);
  });

  it("maps Deepgram errors to onError", () => {
    const conn = new FakeLiveConnection();
    const p = new DeepgramProvider(fakeDeepgram(conn));
    let msg = "";
    p.onError((m) => (msg = m));
    conn.emit(LiveTranscriptionEvents.Error, { message: "bad audio" });
    expect(msg).toBe("bad audio");
  });

  it("maps a Deepgram Close event to onError", () => {
    const conn = new FakeLiveConnection();
    const p = new DeepgramProvider(fakeDeepgram(conn));
    let msg = "";
    p.onError((m) => (msg = m));
    conn.emit(LiveTranscriptionEvents.Close);
    expect(msg).toBe("deepgram connection closed");
  });

  it("requests close on the connection when closed", () => {
    const conn = new FakeLiveConnection();
    const p = new DeepgramProvider(fakeDeepgram(conn));
    p.close();
    expect(conn.closeRequested).toBe(true);
  });
});
