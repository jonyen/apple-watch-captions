// backend/src/callUplink.test.ts
import { describe, it, expect } from "vitest";
import { CallUplink } from "./callUplink";

describe("CallUplink", () => {
  it("refuses to write when no call is attached", () => {
    expect(new CallUplink().write(Buffer.from([1]))).toBe(false);
  });

  it("hands audio to the attached sender", () => {
    const sent: Buffer[] = [];
    const uplink = new CallUplink();
    uplink.attach((mulaw) => sent.push(mulaw));

    expect(uplink.write(Buffer.from([1, 2]))).toBe(true);
    expect([...sent[0]]).toEqual([1, 2]);
  });

  it("stops writing once detached", () => {
    const sent: Buffer[] = [];
    const uplink = new CallUplink();
    uplink.attach((mulaw) => sent.push(mulaw));
    uplink.detach();

    expect(uplink.write(Buffer.from([1]))).toBe(false);
    expect(sent).toHaveLength(0);
  });

  // A new call replaces the old one; audio must never reach a dead socket.
  it("sends to the most recently attached call only", () => {
    const first: Buffer[] = [];
    const second: Buffer[] = [];
    const uplink = new CallUplink();
    uplink.attach((m) => first.push(m));
    uplink.attach((m) => second.push(m));

    uplink.write(Buffer.from([9]));

    expect(first).toHaveLength(0);
    expect(second).toHaveLength(1);
  });
});
