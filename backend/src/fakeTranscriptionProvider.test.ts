import { describe, it, expect } from "vitest";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";

describe("FakeTranscriptionProvider", () => {
  it("records audio it receives", () => {
    const p = new FakeTranscriptionProvider();
    p.sendAudio(Buffer.from("abc"));
    p.sendAudio(Buffer.from("de"));
    expect(Buffer.concat(p.receivedAudio).toString()).toBe("abcde");
  });

  it("emits ready when emitReady() is called", () => {
    const p = new FakeTranscriptionProvider();
    let ready = false;
    p.onReady(() => (ready = true));
    p.emitReady();
    expect(ready).toBe(true);
  });

  it("forwards emitted transcripts to the handler", () => {
    const p = new FakeTranscriptionProvider();
    const got: string[] = [];
    p.onTranscript((t) => got.push(`${t.text}:${t.isFinal}`));
    p.emitTranscript({ text: "hello", isFinal: false });
    p.emitTranscript({ text: "hello world", isFinal: true });
    expect(got).toEqual(["hello:false", "hello world:true"]);
  });
});
