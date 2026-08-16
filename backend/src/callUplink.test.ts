// backend/src/callUplink.test.ts
import { describe, it, expect } from "vitest";
import { CallUplink } from "./callUplink";

describe("CallUplink", () => {
  it("refuses to write when no call is attached", () => {
    expect(new CallUplink().write("user-a", Buffer.from([1]))).toBe(false);
  });

  it("hands audio to the attached sender", () => {
    const sent: Buffer[] = [];
    const uplink = new CallUplink();
    uplink.attach("user-a", (mulaw) => sent.push(mulaw), () => {});

    expect(uplink.write("user-a", Buffer.from([1, 2]))).toBe(true);
    expect([...sent[0]]).toEqual([1, 2]);
  });

  it("stops writing once detached", () => {
    const sent: Buffer[] = [];
    const uplink = new CallUplink();
    const sender = (mulaw: Buffer) => sent.push(mulaw);
    uplink.attach("user-a", sender, () => {});
    uplink.detach("user-a", sender);

    expect(uplink.write("user-a", Buffer.from([1]))).toBe(false);
    expect(sent).toHaveLength(0);
  });

  // A new call replaces the old one; audio must never reach a dead socket.
  it("sends to the most recently attached call only", () => {
    const first: Buffer[] = [];
    const second: Buffer[] = [];
    const uplink = new CallUplink();
    uplink.attach("user-a", (m) => first.push(m), () => {});
    uplink.attach("user-a", (m) => second.push(m), () => {});

    uplink.write("user-a", Buffer.from([9]));

    expect(first).toHaveLength(0);
    expect(second).toHaveLength(1);
  });

  it("detaching the currently attached sender clears it and returns true", () => {
    const sent: Buffer[] = [];
    const sender = (mulaw: Buffer) => sent.push(mulaw);
    const uplink = new CallUplink();
    uplink.attach("user-a", sender, () => {});

    const result = uplink.detach("user-a", sender);

    expect(result).toBe(true);
    expect(uplink.write("user-a", Buffer.from([1]))).toBe(false);
  });

  it("detaching a superseded sender returns false and leaves the newer sender attached", () => {
    const firstSent: Buffer[] = [];
    const secondSent: Buffer[] = [];
    const firstSender = (mulaw: Buffer) => firstSent.push(mulaw);
    const secondSender = (mulaw: Buffer) => secondSent.push(mulaw);
    const uplink = new CallUplink();

    uplink.attach("user-a", firstSender, () => {});
    uplink.attach("user-a", secondSender, () => {});

    const result = uplink.detach("user-a", firstSender);

    expect(result).toBe(false);
    expect(uplink.write("user-a", Buffer.from([42]))).toBe(true);
    expect(secondSent).toHaveLength(1);
    expect(firstSent).toHaveLength(0);
  });

  // Under <Connect><Stream> the socket *is* the call, and the watch is not a
  // party to it — so this closer is the only thing that can hang up.
  it("hangs up by closing the attached call's socket", () => {
    let closed = 0;
    const uplink = new CallUplink();
    uplink.attach("user-a", () => {}, () => { closed += 1; });

    expect(uplink.end("user-a")).toBe(true);
    expect(closed).toBe(1);
  });

  it("reports nothing to hang up when no call is attached", () => {
    expect(new CallUplink().end("user-a")).toBe(false);
  });

  // A second hangup must not close a call that arrived in between, and the
  // route answering it must be able to say "there is no call" honestly.
  it("leaves nothing attached after hanging up", () => {
    let closed = 0;
    const uplink = new CallUplink();
    uplink.attach("user-a", () => {}, () => { closed += 1; });
    uplink.end("user-a");

    expect(uplink.end("user-a")).toBe(false);
    expect(uplink.write("user-a", Buffer.from([1]))).toBe(false);
    expect(closed).toBe(1);
  });

  // The closer usually triggers the socket's own close handling, which
  // detaches. Clearing before the closer runs is what keeps that from
  // reaching back in and finding half-torn-down state.
  it("is already detached by the time the closer runs", () => {
    const uplink = new CallUplink();
    let seenDuringClose: boolean | null = null;
    uplink.attach("user-a", () => {}, () => {
      seenDuringClose = uplink.write("user-a", Buffer.from([1]));
    });

    uplink.end("user-a");

    expect(seenDuringClose).toBe(false);
  });

  // The reason this is a map and not one sender/closer pair: with a single
  // slot, any self-registered device could speak into a stranger's live call
  // or hang it up — the exact attack `CurrentCall`'s keying already closes
  // for the captions half.
  it("keeps each user's call in their own compartment", () => {
    const aSent: Buffer[] = [];
    let aClosed = 0;
    const uplink = new CallUplink();
    uplink.attach("user-a", (m) => aSent.push(m), () => { aClosed += 1; });

    // b has no call: writing and hanging up must fail for b...
    expect(uplink.write("user-b", Buffer.from([1]))).toBe(false);
    expect(uplink.end("user-b")).toBe(false);
    // ...and must not have touched a's call.
    expect(aSent).toHaveLength(0);
    expect(aClosed).toBe(0);
    expect(uplink.write("user-a", Buffer.from([2]))).toBe(true);
  });

  it("attaches one live call per user, not per process", () => {
    const aSent: Buffer[] = [];
    const bSent: Buffer[] = [];
    const uplink = new CallUplink();
    uplink.attach("user-a", (m) => aSent.push(m), () => {});
    uplink.attach("user-b", (m) => bSent.push(m), () => {});

    // b attaching must not have displaced a — these are two concurrent calls.
    expect(uplink.write("user-a", Buffer.from([1]))).toBe(true);
    expect(uplink.write("user-b", Buffer.from([2]))).toBe(true);
    expect(aSent).toHaveLength(1);
    expect(bSent).toHaveLength(1);
    expect([...aSent[0]]).toEqual([1]);
    expect([...bSent[0]]).toEqual([2]);
  });

  it("ends only the named user's call", () => {
    let aClosed = 0;
    let bClosed = 0;
    const uplink = new CallUplink();
    uplink.attach("user-a", () => {}, () => { aClosed += 1; });
    uplink.attach("user-b", () => {}, () => { bClosed += 1; });

    expect(uplink.end("user-b")).toBe(true);

    expect(bClosed).toBe(1);
    expect(aClosed).toBe(0);
    expect(uplink.write("user-a", Buffer.from([1]))).toBe(true);
  });
});
