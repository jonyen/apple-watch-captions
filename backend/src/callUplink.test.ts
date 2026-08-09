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
    uplink.attach((mulaw) => sent.push(mulaw), () => {});

    expect(uplink.write(Buffer.from([1, 2]))).toBe(true);
    expect([...sent[0]]).toEqual([1, 2]);
  });

  it("stops writing once detached", () => {
    const sent: Buffer[] = [];
    const uplink = new CallUplink();
    const sender = (mulaw: Buffer) => sent.push(mulaw);
    uplink.attach(sender, () => {});
    uplink.detach(sender);

    expect(uplink.write(Buffer.from([1]))).toBe(false);
    expect(sent).toHaveLength(0);
  });

  // A new call replaces the old one; audio must never reach a dead socket.
  it("sends to the most recently attached call only", () => {
    const first: Buffer[] = [];
    const second: Buffer[] = [];
    const uplink = new CallUplink();
    uplink.attach((m) => first.push(m), () => {});
    uplink.attach((m) => second.push(m), () => {});

    uplink.write(Buffer.from([9]));

    expect(first).toHaveLength(0);
    expect(second).toHaveLength(1);
  });

  it("detaching the currently attached sender clears it and returns true", () => {
    const sent: Buffer[] = [];
    const sender = (mulaw: Buffer) => sent.push(mulaw);
    const uplink = new CallUplink();
    uplink.attach(sender, () => {});

    const result = uplink.detach(sender);

    expect(result).toBe(true);
    expect(uplink.write(Buffer.from([1]))).toBe(false);
  });

  it("detaching a superseded sender returns false and leaves the newer sender attached", () => {
    const firstSent: Buffer[] = [];
    const secondSent: Buffer[] = [];
    const firstSender = (mulaw: Buffer) => firstSent.push(mulaw);
    const secondSender = (mulaw: Buffer) => secondSent.push(mulaw);
    const uplink = new CallUplink();

    uplink.attach(firstSender, () => {});
    uplink.attach(secondSender, () => {});

    const result = uplink.detach(firstSender);

    expect(result).toBe(false);
    expect(uplink.write(Buffer.from([42]))).toBe(true);
    expect(secondSent).toHaveLength(1);
    expect(firstSent).toHaveLength(0);
  });

  // Under <Connect><Stream> the socket *is* the call, and the watch is not a
  // party to it — so this closer is the only thing that can hang up.
  it("hangs up by closing the attached call's socket", () => {
    let closed = 0;
    const uplink = new CallUplink();
    uplink.attach(() => {}, () => { closed += 1; });

    expect(uplink.end()).toBe(true);
    expect(closed).toBe(1);
  });

  it("reports nothing to hang up when no call is attached", () => {
    expect(new CallUplink().end()).toBe(false);
  });

  // A second hangup must not close a call that arrived in between, and the
  // route answering it must be able to say "there is no call" honestly.
  it("leaves nothing attached after hanging up", () => {
    let closed = 0;
    const uplink = new CallUplink();
    uplink.attach(() => {}, () => { closed += 1; });
    uplink.end();

    expect(uplink.end()).toBe(false);
    expect(uplink.write(Buffer.from([1]))).toBe(false);
    expect(closed).toBe(1);
  });

  // The closer usually triggers the socket's own close handling, which
  // detaches. Clearing before the closer runs is what keeps that from
  // reaching back in and finding half-torn-down state.
  it("is already detached by the time the closer runs", () => {
    const uplink = new CallUplink();
    let seenDuringClose: boolean | null = null;
    uplink.attach(() => {}, () => { seenDuringClose = uplink.write(Buffer.from([1])); });

    uplink.end();

    expect(seenDuringClose).toBe(false);
  });
});
