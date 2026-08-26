import { describe, it, expect, afterEach } from "vitest";
import { AddressInfo } from "net";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { startServer, CaptionServer } from "./server";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";
import { TranscriptStore } from "./transcriptStore";
import { IdentityStore } from "./identityStore";
import { openDb } from "./db";

// Regression coverage for the pre-existing race the training-capture feature
// surfaced: on the HTTP `/v1/audio` + `/v1/stop` transport, `/v1/stop` used
// to finalize the transcript the instant it called `session.caption.close()`
// — synchronously, before the Apple provider's asynchronous finish/done
// handshake could possibly deliver the true final. The final still arrived
// eventually, but by then `SessionStore` had already forgotten the session,
// so `TranscriptStore.append` silently opened a second, never-finalized
// `.jsonl` file instead of landing in the one that had just been finalized.
//
// `FakeTranscriptionProvider.closeBarrier` stands in for that asynchronous
// window: `close()` does not resolve until the test says so, exactly the
// shape `AppleTranscriptionProvider`'s finish/done handshake has.

let running: CaptionServer | null = null;
let transcriptsDir: string | null = null;

afterEach(async () => {
  if (running) await running.close();
  running = null;
  if (transcriptsDir) rmSync(transcriptsDir, { recursive: true, force: true });
  transcriptsDir = null;
});

function authHeaders(token: string) {
  return { authorization: `Bearer ${token}` };
}

function start() {
  transcriptsDir = mkdtempSync(join(tmpdir(), "transcripts-race-"));
  const identity = new IdentityStore(openDb(":memory:"));
  const device = identity.registerDevice("watch");
  const providers: FakeTranscriptionProvider[] = [];
  const transcripts = new TranscriptStore({ root: transcriptsDir });
  const server = startServer({
    port: 0,
    identity,
    createProvider: () => {
      const p = new FakeTranscriptionProvider();
      providers.push(p);
      return p;
    },
    transcripts,
    transcriptsRoot: transcriptsDir,
    transcriptionProvider: "apple",
  });
  running = server;
  const port = (server.address() as AddressInfo).port;
  return { providers, port, token: device.token };
}

function postAudio(port: number, session: string, token: string, body: Buffer) {
  return fetch(`http://127.0.0.1:${port}/v1/audio?session=${session}`, {
    method: "POST",
    headers: authHeaders(token),
    body: new Uint8Array(body),
  });
}

function stop(port: number, session: string, token: string) {
  return fetch(`http://127.0.0.1:${port}/v1/stop?session=${session}`, {
    method: "POST",
    headers: authHeaders(token),
  });
}

function jsonlFiles(dir: string): string[] {
  const userDir = join(dir, readdirSync(dir)[0]!);
  return readdirSync(userDir).filter((f) => f.endsWith(".jsonl"));
}

describe("HTTP /v1/stop finalize race", () => {
  it("a stop with a pending provider final lands that final in the one finalized transcript, not an orphaned second file", async () => {
    const { providers, port, token } = start();
    await postAudio(port, "race1", token, Buffer.from("some pcm"));

    let resolveClose!: () => void;
    providers[0]!.closeBarrier = new Promise((r) => {
      resolveClose = r;
    });

    const stopReq = stop(port, "race1", token);
    // Give the request time to actually reach the handler and call
    // session.caption.close() (real localhost I/O, not synchronous).
    await new Promise((r) => setTimeout(r, 30));

    // The true final arrives in the window /v1/stop is waiting through.
    providers[0]!.emitTranscript({ text: "the true final", isFinal: true });
    resolveClose();

    const res = await stopReq;
    expect(res.status).toBe(200);

    const files = jsonlFiles(transcriptsDir!);
    expect(files).toHaveLength(1); // no orphaned second transcript file
    const userDir = join(transcriptsDir!, readdirSync(transcriptsDir!)[0]!);
    const lines = readFileSync(join(userDir, files[0]!), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.text)).toEqual(["the true final"]);
  });

  it("a stop whose provider never resolves close() on its own still finalizes once the provider does (bounded by the provider, not left hanging forever)", async () => {
    const { providers, port, token } = start();
    await postAudio(port, "race2", token, Buffer.from("some pcm"));

    let resolveClose!: () => void;
    providers[0]!.closeBarrier = new Promise((r) => {
      resolveClose = r;
    });

    const stopReq = stop(port, "race2", token);
    await new Promise((r) => setTimeout(r, 30));

    // No final ever arrives — simulate the provider eventually giving up on
    // its own bound (what AppleTranscriptionProvider's FINISH_TIMEOUT_MS
    // does in production) rather than hanging forever.
    resolveClose();

    const res = await stopReq;
    expect(res.status).toBe(200);
    // No final line was ever appended, so TranscriptStore never created a
    // file for this session at all — nothing orphaned, nothing invented.
    expect(readdirSync(transcriptsDir!)).toEqual([]);
  });
});
