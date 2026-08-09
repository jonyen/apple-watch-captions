import { describe, it, expect } from "vitest";
import { CallAudioBuffer } from "./callAudioBuffer";

describe("CallAudioBuffer", () => {
  it("hands back everything after the caller's cursor", () => {
    const buffer = new CallAudioBuffer();
    buffer.append(Buffer.from([1, 2]));
    buffer.append(Buffer.from([3, 4]));

    const { audio, seq } = buffer.drain(0);

    expect([...audio]).toEqual([1, 2, 3, 4]);
    expect(seq).toBe(2);
  });

  it("hands back only what is new on the next poll", () => {
    const buffer = new CallAudioBuffer();
    buffer.append(Buffer.from([1, 2]));
    const first = buffer.drain(0);
    buffer.append(Buffer.from([3, 4]));

    const second = buffer.drain(first.seq);

    expect([...second.audio]).toEqual([3, 4]);
  });

  it("returns nothing when the caller is already current", () => {
    const buffer = new CallAudioBuffer();
    buffer.append(Buffer.from([1, 2]));
    const { seq } = buffer.drain(0);

    expect(buffer.drain(seq).audio.length).toBe(0);
  });

  // Live audio: a backlog is worse than a gap, because playing stale speech
  // puts the listener further behind rather than catching them up.
  it("drops the oldest audio rather than growing past its bound", () => {
    const buffer = new CallAudioBuffer(4);
    buffer.append(Buffer.from([1, 2]));
    buffer.append(Buffer.from([3, 4]));
    buffer.append(Buffer.from([5, 6]));

    const { audio } = buffer.drain(0);

    expect([...audio]).toEqual([3, 4, 5, 6]);
  });

  it("keeps the cursor monotonic even after dropping", () => {
    const buffer = new CallAudioBuffer(4);
    buffer.append(Buffer.from([1, 2]));
    buffer.append(Buffer.from([3, 4]));
    buffer.append(Buffer.from([5, 6]));

    expect(buffer.drain(0).seq).toBe(3);
  });

  it("forgets everything on clear", () => {
    const buffer = new CallAudioBuffer();
    buffer.append(Buffer.from([1, 2]));

    buffer.clear();

    expect(buffer.drain(0).audio.length).toBe(0);
  });
});
