import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "fs";
import { tmpdir } from "os";

// `fs`'s named exports are non-configurable on this platform, so `vi.spyOn`
// cannot redefine them directly. Mocking the module instead — wrapping each
// function in `vi.fn(actual)` so it behaves exactly like the real thing
// unless a specific test overrides it for one call — gives the TOCTOU test
// below a way to inject a write partway through `moveTranscripts` without
// touching production code.
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});
import { join } from "path";
import { startServer, CaptionServer } from "./server";
import { IdentityStore } from "./identityStore";
import { openDb } from "./db";
import { TranscriptStore, userDir, listTranscripts } from "./transcriptStore";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";

let server: CaptionServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function start(root: string, now?: () => number) {
  const identity = new IdentityStore(openDb(":memory:"), now ? { now } : {});
  const transcripts = new TranscriptStore({ root, now });
  server = startServer({
    port: 0,
    identity,
    createProvider: () => new FakeTranscriptionProvider(),
    transcripts,
    transcriptsRoot: root,
  });
  const addr = server.address();
  return {
    port: typeof addr === "object" && addr ? addr.port : 0,
    identity,
    transcripts,
  };
}

function issueCode(port: number, token: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/pair/code`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
}

function claimCode(port: number, token: string, code: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/pair/claim`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ code }),
  });
}

describe("pairing", () => {
  it("merges the watch into the phone's account", async () => {
    const root = fs.mkdtempSync(join(tmpdir(), "wc-"));
    const { port, identity } = start(root);
    const phone = identity.registerDevice("phone");
    const watch = identity.registerDevice("watch");

    const issued = await issueCode(port, phone.token);
    const { code } = (await issued.json()) as { code: string };

    const claimed = await claimCode(port, watch.token, code);
    expect(claimed.status).toBe(200);
    expect((await claimed.json()) as { userId: string }).toEqual({ userId: phone.userId });
    expect(identity.resolve(watch.token)!.userId).toBe(phone.userId);
  });

  it("moves the claiming device's transcripts to the new owner", async () => {
    const root = fs.mkdtempSync(join(tmpdir(), "wc-"));
    const { port, identity, transcripts } = start(root);
    const phone = identity.registerDevice("phone");
    const watch = identity.registerDevice("watch");
    transcripts.append(watch.userId, "s1", "recorded before pairing");
    transcripts.finalize(watch.userId, "s1");

    const issued = await issueCode(port, phone.token);
    const { code } = (await issued.json()) as { code: string };
    await claimCode(port, watch.token, code);

    expect(listTranscripts(userDir(root, phone.userId))).toHaveLength(1);
    expect(fs.existsSync(userDir(root, watch.userId))).toBe(false);
  });

  it("rejects an unknown code", async () => {
    const root = fs.mkdtempSync(join(tmpdir(), "wc-"));
    const { port, identity } = start(root);
    const watch = identity.registerDevice("watch");
    const res = await claimCode(port, watch.token, "000000");
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toEqual({ error: "unknown" });
  });

  it("requires authentication to issue a code", async () => {
    const root = fs.mkdtempSync(join(tmpdir(), "wc-"));
    const { port } = start(root);
    const res = await fetch(`http://127.0.0.1:${port}/v1/pair/code`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("requires authentication to claim a code", async () => {
    const root = fs.mkdtempSync(join(tmpdir(), "wc-"));
    const { port } = start(root);
    const res = await fetch(`http://127.0.0.1:${port}/v1/pair/claim`, {
      method: "POST",
      body: JSON.stringify({ code: "123456" }),
    });
    expect(res.status).toBe(401);
  });

  it("treats claiming your own code as a no-op for both the token and transcripts", async () => {
    const root = fs.mkdtempSync(join(tmpdir(), "wc-"));
    const { port, identity, transcripts } = start(root);
    const phone = identity.registerDevice("phone");
    transcripts.append(phone.userId, "s1", "already mine");
    transcripts.finalize(phone.userId, "s1");

    const issued = await issueCode(port, phone.token);
    const { code } = (await issued.json()) as { code: string };

    // With the collision guard in place, moving a directory onto itself
    // would look exactly like a same-name collision on every entry and
    // no-op the same way a real self-claim should — so an assertion on the
    // end state alone (token unchanged, one transcript) cannot tell a
    // deliberately-skipped move apart from one that ran and happened to
    // cancel itself out via the collision path. The mover logs a
    // console.error for every stranded entry, so its total silence is what
    // actually proves the move was skipped outright, the way a real
    // self-claim must.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const claimed = await claimCode(port, phone.token, code);
    expect(claimed.status).toBe(200);
    expect((await claimed.json()) as { userId: string }).toEqual({ userId: phone.userId });
    expect(identity.resolve(phone.token)).toEqual({
      userId: phone.userId,
      deviceId: phone.deviceId,
    });
    expect(listTranscripts(userDir(root, phone.userId))).toHaveLength(1);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("pairs cleanly when the claiming device has no transcripts directory", async () => {
    const root = fs.mkdtempSync(join(tmpdir(), "wc-"));
    const { port, identity } = start(root);
    const phone = identity.registerDevice("phone");
    const watch = identity.registerDevice("watch");
    // Neither device has recorded anything yet, so neither directory exists.

    const issued = await issueCode(port, phone.token);
    const { code } = (await issued.json()) as { code: string };

    const claimed = await claimCode(port, watch.token, code);
    expect(claimed.status).toBe(200);
    expect(identity.resolve(watch.token)!.userId).toBe(phone.userId);
    expect(fs.existsSync(userDir(root, watch.userId))).toBe(false);
  });

  it("does not silently overwrite a same-named transcript the destination already owns", async () => {
    const root = fs.mkdtempSync(join(tmpdir(), "wc-"));
    // A shared fixed clock plus the same session id on both users produces
    // the same transcript filename on both sides, forcing a real collision.
    const { port, identity, transcripts } = start(root, () => 1_700_000_000_000);
    const phone = identity.registerDevice("phone");
    const watch = identity.registerDevice("watch");
    transcripts.append(phone.userId, "s1", "phone's own recording");
    transcripts.finalize(phone.userId, "s1");
    transcripts.append(watch.userId, "s1", "watch's recording");
    transcripts.finalize(watch.userId, "s1");

    const [phoneOnly] = listTranscripts(userDir(root, phone.userId));
    const [watchOnly] = listTranscripts(userDir(root, watch.userId));
    // Guards the test's own premise: if the names ever diverge, this test is
    // no longer exercising a collision and would pass for the wrong reason.
    expect(phoneOnly.name).toBe(watchOnly.name);

    const issued = await issueCode(port, phone.token);
    const { code } = (await issued.json()) as { code: string };
    const claimed = await claimCode(port, watch.token, code);
    expect(claimed.status).toBe(200);

    // The phone's own transcript survives untouched, not silently
    // overwritten by the watch's colliding file.
    const phoneTranscripts = listTranscripts(userDir(root, phone.userId));
    expect(phoneTranscripts).toHaveLength(1);
    expect(phoneTranscripts[0].preview).toContain("phone's own recording");

    // The watch's colliding transcript is left in its old directory —
    // stranded and recoverable — rather than deleted along with the rest of
    // an otherwise-emptied directory.
    expect(fs.existsSync(userDir(root, watch.userId))).toBe(true);
    const stranded = listTranscripts(userDir(root, watch.userId));
    expect(stranded).toHaveLength(1);
    expect(stranded[0].preview).toContain("watch's recording");
  });

  it("never deletes a source directory a late write reaches after the move but before the removal (TOCTOU)", async () => {
    const root = fs.mkdtempSync(join(tmpdir(), "wc-"));
    const { port, identity, transcripts } = start(root);
    const phone = identity.registerDevice("phone");
    const watch = identity.registerDevice("watch");
    transcripts.append(watch.userId, "s1", "recorded before pairing");
    transcripts.finalize(watch.userId, "s1");

    const watchDir = userDir(root, watch.userId);
    const actualFs = await vi.importActual<typeof import("fs")>("fs");
    // Simulates a session still in flight under the old userId: a caption
    // lands in this exact directory right after the mover's per-file loop
    // has already moved the one entry it knew about (so the `stranded`
    // count settles at zero), and before it tries to remove what it still
    // believes is now an empty directory.
    vi.mocked(fs.renameSync).mockImplementationOnce((src, dest) => {
      actualFs.renameSync(src, dest);
      fs.writeFileSync(join(watchDir, "late-arrival.jsonl"), "{}");
    });

    const issued = await issueCode(port, phone.token);
    const { code } = (await issued.json()) as { code: string };
    const claimed = await claimCode(port, watch.token, code);
    expect(claimed.status).toBe(200);

    // The `stranded` count was zero, so only the non-recursive removal
    // failing on a non-empty directory — not the count — stands between the
    // late arrival and being deleted along with the directory it landed in.
    expect(fs.existsSync(watchDir)).toBe(true);
    expect(fs.existsSync(join(watchDir, "late-arrival.jsonl"))).toBe(true);
  });

  it("distinguishes a consumed code from an unknown one", async () => {
    const root = fs.mkdtempSync(join(tmpdir(), "wc-"));
    const { port, identity } = start(root);
    const phone = identity.registerDevice("phone");
    const watch = identity.registerDevice("watch");
    const other = identity.registerDevice("mac");

    const issued = await issueCode(port, phone.token);
    const { code } = (await issued.json()) as { code: string };

    const first = await claimCode(port, watch.token, code);
    expect(first.status).toBe(200);

    const second = await claimCode(port, other.token, code);
    expect(second.status).toBe(409);
    expect((await second.json()) as { error: string }).toEqual({ error: "consumed" });
  });

  it("distinguishes an expired code from an unknown one", async () => {
    const root = fs.mkdtempSync(join(tmpdir(), "wc-"));
    let clock = 1_000_000;
    const { port, identity } = start(root, () => clock);
    const phone = identity.registerDevice("phone");
    const watch = identity.registerDevice("watch");

    const issued = await issueCode(port, phone.token);
    const { code } = (await issued.json()) as { code: string };

    clock += 11 * 60_000; // past the 10-minute TTL

    const res = await claimCode(port, watch.token, code);
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toEqual({ error: "expired" });
  });

  it("rejects a claim body that isn't valid JSON", async () => {
    const root = fs.mkdtempSync(join(tmpdir(), "wc-"));
    const { port, identity } = start(root);
    const watch = identity.registerDevice("watch");
    const res = await fetch(`http://127.0.0.1:${port}/v1/pair/claim`, {
      method: "POST",
      headers: { authorization: `Bearer ${watch.token}` },
      body: "not json",
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({ error: "invalid json" });
  });

  it("rejects a claim body missing the code field", async () => {
    const root = fs.mkdtempSync(join(tmpdir(), "wc-"));
    const { port, identity } = start(root);
    const watch = identity.registerDevice("watch");
    const res = await fetch(`http://127.0.0.1:${port}/v1/pair/claim`, {
      method: "POST",
      headers: { authorization: `Bearer ${watch.token}` },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({ error: "missing code" });
  });
});

describe("pairing code rate limiting", () => {
  // Issuing is not free: each one first sweeps `pairing_codes` for dead rows,
  // on the single SQLite writer every other request shares. Unlimited, one
  // token could drive that forever and pairing would start 500ing for
  // everyone as `issuePairingCode` exhausted its retries.
  it("refuses a device that issues more codes than its budget, while a different device is unaffected", async () => {
    const root = fs.mkdtempSync(join(tmpdir(), "wc-"));
    const { port, identity } = start(root);
    const attacker = identity.registerDevice("phone");
    const bystander = identity.registerDevice("phone");

    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      statuses.push((await issueCode(port, attacker.token)).status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 429]);

    // Its own budget — the attacker's exhaustion does not leak onto it.
    expect((await issueCode(port, bystander.token)).status).toBe(200);
  });

  it("keeps the code budget separate from the failed-claim budget", async () => {
    const root = fs.mkdtempSync(join(tmpdir(), "wc-"));
    const { port, identity } = start(root);
    const device = identity.registerDevice("phone");

    // Five failed claims exhausts the claim budget entirely.
    for (let i = 0; i < 5; i += 1) await claimCode(port, device.token, "000000");
    expect((await claimCode(port, device.token, "000000")).status).toBe(429);

    // The same device can still issue a code: a burst of pairing typos must
    // not lock the device out of the other half of pairing.
    expect((await issueCode(port, device.token)).status).toBe(200);
  });
});

describe("pairing claim rate limiting", () => {
  it("refuses a device after 5 failed attempts within the window, with 429 distinct from 409, while a different device is unaffected", async () => {
    const root = fs.mkdtempSync(join(tmpdir(), "wc-"));
    const { port, identity } = start(root);
    const attacker = identity.registerDevice("watch");
    const bystander = identity.registerDevice("mac");

    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await claimCode(port, attacker.token, "000000");
      statuses.push(res.status);
    }
    expect(statuses).toEqual([409, 409, 409, 409, 409, 429]);

    // A different device gets its own budget — the attacker's exhaustion
    // does not leak onto it.
    const res = await claimCode(port, bystander.token, "000000");
    expect(res.status).toBe(409);
  });

  it("does not count a successful claim against the failed-attempt budget", async () => {
    const root = fs.mkdtempSync(join(tmpdir(), "wc-"));
    const { port, identity } = start(root);
    const phone = identity.registerDevice("phone");
    const watch = identity.registerDevice("watch");

    const issued = await issueCode(port, phone.token);
    const { code } = (await issued.json()) as { code: string };
    const claimed = await claimCode(port, watch.token, code);
    expect(claimed.status).toBe(200);

    // If the successful claim above had spent any of the budget, only 4 of
    // the 5 failed guesses below would return 409 before the 429 arrives.
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await claimCode(port, watch.token, "000000");
      statuses.push(res.status);
    }
    expect(statuses).toEqual([409, 409, 409, 409, 409, 429]);
  });
});
