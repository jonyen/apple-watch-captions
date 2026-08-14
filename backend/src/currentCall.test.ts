import { describe, it, expect } from "vitest";
import { CurrentCall } from "./currentCall";

describe("CurrentCall", () => {
  it("has no call to begin with", () => {
    const calls = new CurrentCall();
    expect(calls.current()).toBeNull();
    expect(calls.lastReason("user-a")).toBeNull();
  });

  it("holds the call it was given", () => {
    const calls = new CurrentCall();
    calls.begin("CA1", "CA1", "user-a");
    expect(calls.current()).toEqual({ sessionId: "CA1", callSid: "CA1", userId: "user-a" });
  });

  it("records how the call ended", () => {
    const calls = new CurrentCall();
    calls.begin("CA1", "CA1", "user-a");

    expect(calls.end("CA1", "user-a", "ended")).toBe(true);

    expect(calls.current()).toBeNull();
    expect(calls.lastReason("user-a")).toBe("ended");
  });

  // A dying socket from a call that was already replaced must not clear the
  // call that replaced it.
  it("ignores an end from a call that is no longer current", () => {
    const calls = new CurrentCall();
    calls.begin("CA1", "CA1", "user-a");
    calls.begin("CA2", "CA2", "user-a");

    expect(calls.end("CA1", "user-a", "stream_lost")).toBe(false);

    expect(calls.current()).toEqual({ sessionId: "CA2", callSid: "CA2", userId: "user-a" });
    expect(calls.lastReason("user-a")).toBeNull();
  });

  // Same sessionId, different owner — must not happen with today's globally
  // unique Twilio callSids, but the check must not trust sessionId alone.
  it("ignores an end whose userId does not match the current call's owner", () => {
    const calls = new CurrentCall();
    calls.begin("CA1", "CA1", "user-a");

    expect(calls.end("CA1", "user-b", "ended")).toBe(false);

    expect(calls.current()).toEqual({ sessionId: "CA1", callSid: "CA1", userId: "user-a" });
    expect(calls.lastReason("user-a")).toBeNull();
  });

  it("clears a stale end reason when a new call begins", () => {
    const calls = new CurrentCall();
    calls.begin("CA1", "CA1", "user-a");
    calls.end("CA1", "user-a", "stream_lost");

    calls.begin("CA2", "CA2", "user-a");

    expect(calls.lastReason("user-a")).toBeNull();
  });

  // CurrentCall is process-global — one call at a time across every user —
  // so without scoping, whoever ended a call would leak both that a call
  // just ended and how to any other user who happens to poll next.
  it("does not report the end reason to a user who did not own the call", () => {
    const calls = new CurrentCall();
    calls.begin("CA1", "CA1", "user-a");
    calls.end("CA1", "user-a", "ended");

    expect(calls.lastReason("user-b")).toBeNull();
    expect(calls.lastReason("user-a")).toBe("ended");
  });
});
