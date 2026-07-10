import { describe, it, expect } from "vitest";
import { ChannelSplitProvider } from "./channelSplitProvider";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";
import { Transcript } from "./transcriptionProvider";

function stereo(...pairs: [number, number][]): Buffer {
  const buf = Buffer.alloc(pairs.length * 4);
  pairs.forEach(([l, r], f) => {
    buf.writeInt16LE(l, f * 4);
    buf.writeInt16LE(r, f * 4 + 2);
  });
  return buf;
}

function mono(buf: Buffer): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < buf.length; i += 2) out.push(buf.readInt16LE(i));
  return out;
}

function makeSplit() {
  const inners: FakeTranscriptionProvider[] = [];
  const split = new ChannelSplitProvider(() => {
    const p = new FakeTranscriptionProvider();
    inners.push(p);
    return p;
  });
  return { split, inners };
}

describe("ChannelSplitProvider", () => {
  it("creates one inner provider per channel", () => {
    const { inners } = makeSplit();
    expect(inners).toHaveLength(2);
  });

  it("fires ready only after both inner providers are ready", () => {
    const { split, inners } = makeSplit();
    let ready = false;
    split.onReady(() => (ready = true));
    inners[0].emitReady();
    expect(ready).toBe(false);
    inners[1].emitReady();
    expect(ready).toBe(true);
  });

  it("de-interleaves stereo audio into per-channel mono streams", () => {
    const { split, inners } = makeSplit();
    split.sendAudio(stereo([1, -1], [2, -2], [3, -3]));
    expect(mono(Buffer.concat(inners[0].receivedAudio))).toEqual([1, 2, 3]);
    expect(mono(Buffer.concat(inners[1].receivedAudio))).toEqual([-1, -2, -3]);
  });

  it("carries a partial stereo frame over to the next chunk", () => {
    const { split, inners } = makeSplit();
    const full = stereo([10, 20], [30, 40]);
    split.sendAudio(full.subarray(0, 5));
    split.sendAudio(full.subarray(5));
    expect(mono(Buffer.concat(inners[0].receivedAudio))).toEqual([10, 30]);
    expect(mono(Buffer.concat(inners[1].receivedAudio))).toEqual([20, 40]);
  });

  it("tags transcripts with their channel", () => {
    const { split, inners } = makeSplit();
    const got: Transcript[] = [];
    split.onTranscript((t) => got.push(t));
    inners[0].emitTranscript({ text: "from mic", isFinal: true });
    inners[1].emitTranscript({ text: "from system", isFinal: false });
    expect(got).toEqual([
      { text: "from mic", isFinal: true, channel: 0 },
      { text: "from system", isFinal: false, channel: 1 },
    ]);
  });

  it("surfaces only the first inner error", () => {
    const { split, inners } = makeSplit();
    const errors: string[] = [];
    split.onError((m) => errors.push(m));
    inners[0].emitError("boom");
    inners[1].emitError("boom two");
    expect(errors).toEqual(["boom"]);
  });

  it("closes both inner providers", () => {
    const { split, inners } = makeSplit();
    split.close();
    expect(inners.every((p) => p.closed)).toBe(true);
  });
});
