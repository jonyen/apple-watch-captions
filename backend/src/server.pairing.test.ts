import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, existsSync } from "fs";
import { tmpdir } from "os";
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
    const root = mkdtempSync(join(tmpdir(), "wc-"));
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
    const root = mkdtempSync(join(tmpdir(), "wc-"));
    const { port, identity, transcripts } = start(root);
    const phone = identity.registerDevice("phone");
    const watch = identity.registerDevice("watch");
    transcripts.append(watch.userId, "s1", "recorded before pairing");
    transcripts.finalize(watch.userId, "s1");

    const issued = await issueCode(port, phone.token);
    const { code } = (await issued.json()) as { code: string };
    await claimCode(port, watch.token, code);

    expect(listTranscripts(userDir(root, phone.userId))).toHaveLength(1);
    expect(existsSync(userDir(root, watch.userId))).toBe(false);
  });

  it("rejects an unknown code", async () => {
    const root = mkdtempSync(join(tmpdir(), "wc-"));
    const { port, identity } = start(root);
    const watch = identity.registerDevice("watch");
    const res = await claimCode(port, watch.token, "000000");
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toEqual({ error: "unknown" });
  });

  it("requires authentication to issue a code", async () => {
    const root = mkdtempSync(join(tmpdir(), "wc-"));
    const { port } = start(root);
    const res = await fetch(`http://127.0.0.1:${port}/v1/pair/code`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("requires authentication to claim a code", async () => {
    const root = mkdtempSync(join(tmpdir(), "wc-"));
    const { port } = start(root);
    const res = await fetch(`http://127.0.0.1:${port}/v1/pair/claim`, {
      method: "POST",
      body: JSON.stringify({ code: "123456" }),
    });
    expect(res.status).toBe(401);
  });

  it("treats claiming your own code as a no-op for both the token and transcripts", async () => {
    const root = mkdtempSync(join(tmpdir(), "wc-"));
    const { port, identity, transcripts } = start(root);
    const phone = identity.registerDevice("phone");
    transcripts.append(phone.userId, "s1", "already mine");
    transcripts.finalize(phone.userId, "s1");

    const issued = await issueCode(port, phone.token);
    const { code } = (await issued.json()) as { code: string };

    const claimed = await claimCode(port, phone.token, code);
    expect(claimed.status).toBe(200);
    expect((await claimed.json()) as { userId: string }).toEqual({ userId: phone.userId });
    // The device's own token still resolves to the same principal — a
    // self-claim must not rotate anything.
    expect(identity.resolve(phone.token)).toEqual({
      userId: phone.userId,
      deviceId: phone.deviceId,
    });
    expect(listTranscripts(userDir(root, phone.userId))).toHaveLength(1);
  });

  it("pairs cleanly when the claiming device has no transcripts directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "wc-"));
    const { port, identity } = start(root);
    const phone = identity.registerDevice("phone");
    const watch = identity.registerDevice("watch");
    // Neither device has recorded anything yet, so neither directory exists.

    const issued = await issueCode(port, phone.token);
    const { code } = (await issued.json()) as { code: string };

    const claimed = await claimCode(port, watch.token, code);
    expect(claimed.status).toBe(200);
    expect(identity.resolve(watch.token)!.userId).toBe(phone.userId);
    expect(existsSync(userDir(root, watch.userId))).toBe(false);
  });

  it("does not silently overwrite a same-named transcript the destination already owns", async () => {
    const root = mkdtempSync(join(tmpdir(), "wc-"));
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
    expect(existsSync(userDir(root, watch.userId))).toBe(true);
    const stranded = listTranscripts(userDir(root, watch.userId));
    expect(stranded).toHaveLength(1);
    expect(stranded[0].preview).toContain("watch's recording");
  });

  it("distinguishes a consumed code from an unknown one", async () => {
    const root = mkdtempSync(join(tmpdir(), "wc-"));
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
    const root = mkdtempSync(join(tmpdir(), "wc-"));
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
});
