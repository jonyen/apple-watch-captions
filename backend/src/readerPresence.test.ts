import { describe, it, expect } from "vitest";
import { ReaderPresence } from "./readerPresence";

function at(clock: { t: number }, windowMs = 10_000) {
  return new ReaderPresence({ windowMs, now: () => clock.t });
}

describe("ReaderPresence", () => {
  it("reports nobody reading a session that has never been read", () => {
    const clock = { t: 0 };
    expect(at(clock).isPresent("phone-audio")).toBe(false);
  });

  it("reports a reader immediately after a mark", () => {
    const clock = { t: 1_000 };
    const presence = at(clock);

    presence.mark("phone-audio");

    expect(presence.isPresent("phone-audio")).toBe(true);
  });

  it("keeps reporting a reader up to the end of the window", () => {
    const clock = { t: 0 };
    const presence = at(clock);
    presence.mark("phone-audio");

    clock.t = 10_000;

    expect(presence.isPresent("phone-audio")).toBe(true);
  });

  it("stops reporting a reader once the window has passed", () => {
    const clock = { t: 0 };
    const presence = at(clock);
    presence.mark("phone-audio");

    clock.t = 10_001;

    expect(presence.isPresent("phone-audio")).toBe(false);
  });

  it("extends presence on every mark, so continued reading stays present", () => {
    const clock = { t: 0 };
    const presence = at(clock);
    presence.mark("phone-audio");

    clock.t = 9_000;
    presence.mark("phone-audio");
    clock.t = 18_000;

    expect(presence.isPresent("phone-audio")).toBe(true);
  });

  it("tracks sessions separately", () => {
    const clock = { t: 0 };
    const presence = at(clock);

    presence.mark("phone-audio");

    expect(presence.isPresent("other")).toBe(false);
  });

  it("forgets a session on clear, so leaving is immediate", () => {
    const clock = { t: 0 };
    const presence = at(clock);
    presence.mark("phone-audio");

    presence.clear("phone-audio");

    expect(presence.isPresent("phone-audio")).toBe(false);
  });
});
