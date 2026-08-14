import { describe, it, expect } from "vitest";
import { ReaderPresence } from "./readerPresence";

function at(clock: { t: number }, windowMs = 10_000) {
  return new ReaderPresence({ windowMs, now: () => clock.t });
}

describe("ReaderPresence", () => {
  it("reports nobody reading a session that has never been read", () => {
    const clock = { t: 0 };
    expect(at(clock).isPresent("u1", "phone-audio")).toBe(false);
  });

  it("reports a reader immediately after a mark", () => {
    const clock = { t: 1_000 };
    const presence = at(clock);

    presence.mark("u1", "phone-audio");

    expect(presence.isPresent("u1", "phone-audio")).toBe(true);
  });

  it("keeps reporting a reader up to the end of the window", () => {
    const clock = { t: 0 };
    const presence = at(clock);
    presence.mark("u1", "phone-audio");

    clock.t = 10_000;

    expect(presence.isPresent("u1", "phone-audio")).toBe(true);
  });

  it("stops reporting a reader once the window has passed", () => {
    const clock = { t: 0 };
    const presence = at(clock);
    presence.mark("u1", "phone-audio");

    clock.t = 10_001;

    expect(presence.isPresent("u1", "phone-audio")).toBe(false);
  });

  it("extends presence on every mark, so continued reading stays present", () => {
    const clock = { t: 0 };
    const presence = at(clock);
    presence.mark("u1", "phone-audio");

    clock.t = 9_000;
    presence.mark("u1", "phone-audio");
    clock.t = 18_000;

    expect(presence.isPresent("u1", "phone-audio")).toBe(true);
  });

  it("tracks sessions separately", () => {
    const clock = { t: 0 };
    const presence = at(clock);

    presence.mark("u1", "phone-audio");

    expect(presence.isPresent("u1", "other")).toBe(false);
  });

  it("forgets a session on clear, so leaving is immediate", () => {
    const clock = { t: 0 };
    const presence = at(clock);
    presence.mark("u1", "phone-audio");

    presence.clear("u1", "phone-audio");

    expect(presence.isPresent("u1", "phone-audio")).toBe(false);
  });

  // Isolation: each assertion below is paired with a check that the other
  // user's own answer is unaffected, so a store that merely lost every entry
  // could not pass by accident.
  it("does not report one user's reader as another's", () => {
    const presence = new ReaderPresence();
    presence.mark("user-a", "shared-id");

    expect(presence.isPresent("user-a", "shared-id")).toBe(true);
    expect(presence.isPresent("user-b", "shared-id")).toBe(false);
  });

  it("does not report one user's producer as another's", () => {
    const presence = new ReaderPresence();
    presence.markProducer("user-a", "shared-id");

    expect(presence.isProducing("user-a", "shared-id")).toBe(true);
    expect(presence.isProducing("user-b", "shared-id")).toBe(false);
  });

  it("does not clear another user's presence", () => {
    const presence = new ReaderPresence();
    presence.mark("user-a", "shared-id");
    presence.mark("user-b", "shared-id");

    presence.clear("user-a", "shared-id");

    expect(presence.isPresent("user-a", "shared-id")).toBe(false);
    expect(presence.isPresent("user-b", "shared-id")).toBe(true);
  });
});
