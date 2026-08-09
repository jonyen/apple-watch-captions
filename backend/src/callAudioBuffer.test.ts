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

  // Load-bearing, and easy to "tidy up" into a bug: the watch resets its own
  // cursor to 0 at the start of every call (CallAudio.reset), which is only
  // safe because this counter keeps climbing across calls. Reset seq here and
  // a watch still holding the previous call's cursor would skip the new
  // call's opening seconds as already-heard, with nothing looking wrong from
  // either side.
  it("keeps counting across a clear, so a reset cursor is always behind", () => {
    const buffer = new CallAudioBuffer();
    buffer.append(Buffer.from([1, 2]));
    const before = buffer.drain(0).seq;

    buffer.clear();
    buffer.append(Buffer.from([3, 4]));

    const after = buffer.drain(before);
    expect(after.seq).toBeGreaterThan(before);
    expect([...after.audio]).toEqual([3, 4]);
    // And a cursor of 0 — a fresh call on the watch — still sees it.
    expect([...buffer.drain(0).audio]).toEqual([3, 4]);
  });
});
