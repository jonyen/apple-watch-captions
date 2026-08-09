import { describe, it, expect } from "vitest";
import { CurrentCall } from "./currentCall";

describe("CurrentCall", () => {
  it("has no call to begin with", () => {
    const calls = new CurrentCall();
    expect(calls.current()).toBeNull();
    expect(calls.lastReason()).toBeNull();
  });

  it("holds the call it was given", () => {
    const calls = new CurrentCall();
    calls.begin("CA1", "CA1");
    expect(calls.current()).toEqual({ sessionId: "CA1", callSid: "CA1", twoWay: true });
  });

  // The fallback shape is captions only: the phone holds that call, so the
  // watch can neither speak on it nor hang it up, and the watch has to be
  // told which kind of call it is reading.
  it("remembers a one-way call as one the watch does not hold", () => {
    const calls = new CurrentCall();
    calls.begin("CA1", "CA1", false);
    expect(calls.current()).toEqual({ sessionId: "CA1", callSid: "CA1", twoWay: false });
  });

  it("records how the call ended", () => {
    const calls = new CurrentCall();
    calls.begin("CA1", "CA1");

    expect(calls.end("CA1", "ended")).toBe(true);

    expect(calls.current()).toBeNull();
    expect(calls.lastReason()).toBe("ended");
  });

  // A dying socket from a call that was already replaced must not clear the
  // call that replaced it.
  it("ignores an end from a call that is no longer current", () => {
    const calls = new CurrentCall();
    calls.begin("CA1", "CA1");
    calls.begin("CA2", "CA2");

    expect(calls.end("CA1", "stream_lost")).toBe(false);

    expect(calls.current()).toEqual({ sessionId: "CA2", callSid: "CA2", twoWay: true });
    expect(calls.lastReason()).toBeNull();
  });

  it("clears a stale end reason when a new call begins", () => {
    const calls = new CurrentCall();
    calls.begin("CA1", "CA1");
    calls.end("CA1", "stream_lost");

    calls.begin("CA2", "CA2");

    expect(calls.lastReason()).toBeNull();
  });
});
