// backend/src/callPresence.test.ts
import { describe, it, expect } from "vitest";
import { CallPresence } from "./callPresence";

describe("CallPresence", () => {
  it("is absent before the watch has ever polled", () => {
    expect(new CallPresence().isPresent()).toBe(false);
  });

  it("is present immediately after a poll", () => {
    const presence = new CallPresence();
    presence.mark();
    expect(presence.isPresent()).toBe(true);
  });

  it("goes absent once the window lapses", () => {
    let now = 1_000;
    const presence = new CallPresence({ now: () => now, windowMs: 10_000 });
    presence.mark();

    now += 10_000;
    expect(presence.isPresent()).toBe(true); // exactly at the edge still counts

    now += 1;
    expect(presence.isPresent()).toBe(false);
  });

  it("comes back when the watch polls again", () => {
    let now = 1_000;
    const presence = new CallPresence({ now: () => now, windowMs: 10_000 });
    presence.mark();
    now += 20_000;
    expect(presence.isPresent()).toBe(false);

    presence.mark();

    expect(presence.isPresent()).toBe(true);
  });
});
