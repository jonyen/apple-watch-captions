// backend/src/callPresence.test.ts
import { describe, it, expect } from "vitest";
import { CallPresence } from "./callPresence";

describe("CallPresence", () => {
  it("is absent before the watch has ever polled", () => {
    expect(new CallPresence().isPresent("user-a")).toBe(false);
  });

  it("is present immediately after a poll", () => {
    const presence = new CallPresence();
    presence.mark("user-a");
    expect(presence.isPresent("user-a")).toBe(true);
  });

  it("goes absent once the window lapses", () => {
    let now = 1_000;
    const presence = new CallPresence({ now: () => now, windowMs: 10_000 });
    presence.mark("user-a");

    now += 10_000;
    expect(presence.isPresent("user-a")).toBe(true); // exactly at the edge still counts

    now += 1;
    expect(presence.isPresent("user-a")).toBe(false);
  });

  it("comes back when the watch polls again", () => {
    let now = 1_000;
    const presence = new CallPresence({ now: () => now, windowMs: 10_000 });
    presence.mark("user-a");
    now += 20_000;
    expect(presence.isPresent("user-a")).toBe(false);

    presence.mark("user-a");

    expect(presence.isPresent("user-a")).toBe(true);
  });

  // The reason this is a map and not a scalar: with one shared timestamp, any
  // self-registered device saying "ready" would arm <Connect> for a stranger's
  // inbound call — their caller handed to the wrong wrist.
  it("does not report one user's watch as another user's", () => {
    const presence = new CallPresence();
    presence.mark("user-a");

    expect(presence.isPresent("user-b")).toBe(false);
    // And the mark itself was not lost — this is isolation, not amnesia.
    expect(presence.isPresent("user-a")).toBe(true);
  });

  it("tracks each user's watch independently", () => {
    let now = 1_000;
    const presence = new CallPresence({ now: () => now, windowMs: 10_000 });
    presence.mark("user-a");
    now += 8_000;
    presence.mark("user-b");
    now += 5_000; // a's mark is 13s old, b's is 5s old

    expect(presence.isPresent("user-a")).toBe(false);
    expect(presence.isPresent("user-b")).toBe(true);
  });
});
