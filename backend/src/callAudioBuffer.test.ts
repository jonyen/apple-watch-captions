import { describe, it, expect } from "vitest";
import { CallAudioBuffer } from "./callAudioBuffer";

describe("CallAudioBuffer", () => {
  it("hands back everything after the caller's cursor", () => {
    const buffer = new CallAudioBuffer();
    buffer.append("user-a", Buffer.from([1, 2]));
    buffer.append("user-a", Buffer.from([3, 4]));

    const { audio, seq } = buffer.drain("user-a", 0);

    expect([...audio]).toEqual([1, 2, 3, 4]);
    expect(seq).toBe(2);
  });

  it("hands back only what is new on the next poll", () => {
    const buffer = new CallAudioBuffer();
    buffer.append("user-a", Buffer.from([1, 2]));
    const first = buffer.drain("user-a", 0);
    buffer.append("user-a", Buffer.from([3, 4]));

    const second = buffer.drain("user-a", first.seq);

    expect([...second.audio]).toEqual([3, 4]);
  });

  it("returns nothing when the caller is already current", () => {
    const buffer = new CallAudioBuffer();
    buffer.append("user-a", Buffer.from([1, 2]));
    const { seq } = buffer.drain("user-a", 0);

    expect(buffer.drain("user-a", seq).audio.length).toBe(0);
  });

  it("serves an empty cursor to a user who has never had audio", () => {
    const buffer = new CallAudioBuffer();
    buffer.append("user-a", Buffer.from([1, 2]));

    const { audio, seq } = buffer.drain("user-b", 0);

    expect(audio.length).toBe(0);
    expect(seq).toBe(0);
  });

  // Live audio: a backlog is worse than a gap, because playing stale speech
  // puts the listener further behind rather than catching them up.
  it("drops the oldest audio rather than growing past its bound", () => {
    const buffer = new CallAudioBuffer(4);
    buffer.append("user-a", Buffer.from([1, 2]));
    buffer.append("user-a", Buffer.from([3, 4]));
    buffer.append("user-a", Buffer.from([5, 6]));

    const { audio } = buffer.drain("user-a", 0);

    expect([...audio]).toEqual([3, 4, 5, 6]);
  });

  it("bounds each user's backlog separately", () => {
    const buffer = new CallAudioBuffer(4);
    buffer.append("user-a", Buffer.from([1, 2]));
    buffer.append("user-a", Buffer.from([3, 4]));
    // b's audio must not push a's out of its budget, or vice versa.
    buffer.append("user-b", Buffer.from([9, 9]));

    expect([...buffer.drain("user-a", 0).audio]).toEqual([1, 2, 3, 4]);
    expect([...buffer.drain("user-b", 0).audio]).toEqual([9, 9]);
  });

  it("keeps the cursor monotonic even after dropping", () => {
    const buffer = new CallAudioBuffer(4);
    buffer.append("user-a", Buffer.from([1, 2]));
    buffer.append("user-a", Buffer.from([3, 4]));
    buffer.append("user-a", Buffer.from([5, 6]));

    expect(buffer.drain("user-a", 0).seq).toBe(3);
  });

  it("forgets everything on clear", () => {
    const buffer = new CallAudioBuffer();
    buffer.append("user-a", Buffer.from([1, 2]));

    buffer.clear("user-a");

    expect(buffer.drain("user-a", 0).audio.length).toBe(0);
  });

  it("clears only the named user's audio", () => {
    const buffer = new CallAudioBuffer();
    buffer.append("user-a", Buffer.from([1, 2]));
    buffer.append("user-b", Buffer.from([3, 4]));

    buffer.clear("user-a");

    expect(buffer.drain("user-a", 0).audio.length).toBe(0);
    expect([...buffer.drain("user-b", 0).audio]).toEqual([3, 4]);
  });

  // One user's audio must never come out under another user's cursor — the
  // downlink is what the watch literally plays into the room.
  it("keeps each user's audio in their own compartment", () => {
    const buffer = new CallAudioBuffer();
    buffer.append("user-a", Buffer.from([1, 2]));

    expect(buffer.drain("user-b", 0).audio.length).toBe(0);
    // And a's audio is still waiting for a — a stranger's poll drained nothing.
    expect([...buffer.drain("user-a", 0).audio]).toEqual([1, 2]);
  });

  // Load-bearing, and easy to "tidy up" into a bug: the watch resets its own
  // cursor to 0 at the start of every call (CallAudio.reset), which is only
  // safe because this counter keeps climbing across calls. Reset seq here and
  // a watch still holding the previous call's cursor would skip the new
  // call's opening seconds as already-heard, with nothing looking wrong from
  // either side.
  it("keeps counting across a clear, so a reset cursor is always behind", () => {
    const buffer = new CallAudioBuffer();
    buffer.append("user-a", Buffer.from([1, 2]));
    const before = buffer.drain("user-a", 0).seq;

    buffer.clear("user-a");
    buffer.append("user-a", Buffer.from([3, 4]));

    const after = buffer.drain("user-a", before);
    expect(after.seq).toBeGreaterThan(before);
    expect([...after.audio]).toEqual([3, 4]);
    // And a cursor of 0 — a fresh call on the watch — still sees it.
    expect([...buffer.drain("user-a", 0).audio]).toEqual([3, 4]);
  });

  // The per-user shape of the same invariant: each user's counter must keep
  // climbing across *their* calls, so evict-and-recreate between calls is a
  // regression even when every single-call test above still passes.
  it("keeps each user's cursor climbing across their own calls", () => {
    const buffer = new CallAudioBuffer();
    buffer.append("user-a", Buffer.from([1, 2])); // a's first call
    buffer.append("user-b", Buffer.from([5, 6])); // b's first call
    const aCursor = buffer.drain("user-a", 0).seq;

    buffer.clear("user-a"); // a's call ends; b's does not
    buffer.append("user-a", Buffer.from([3, 4])); // a's second call

    expect(buffer.drain("user-a", 0).seq).toBeGreaterThan(aCursor);
    // b's compartment is untouched by a's call ending.
    expect([...buffer.drain("user-b", 0).audio]).toEqual([5, 6]);
  });
});
