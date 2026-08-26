import { describe, it, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
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

function start(onFinalize?: (t: { name: string; segments: { text: string }[] }) => void) {
  transcriptsDir = mkdtempSync(join(tmpdir(), "transcripts-race-"));
  const identity = new IdentityStore(openDb(":memory:"));
  const device = identity.registerDevice("watch");
  const providers: FakeTranscriptionProvider[] = [];
  const transcripts = new TranscriptStore({ root: transcriptsDir, onFinalize });
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

// The WS `/stream` transport avoids this race only when the client
// cooperates: it sends `{"finish":true}`, waits for the true final, then
// closes. An *abrupt* disconnect — network drop, app killed — lands in
// `closeOnce` with the provider's finish handshake still in flight, the
// exact shape /v1/stop had. `closeOnce` must await the provider's close
// before finalizing, or the late final orphans a second transcript file
// (or, with no earlier final, an active entry whose finalize hook never
// fires at all).
describe("WS abrupt-disconnect finalize race", () => {
  async function until(cond: () => boolean, ms = 2000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error("condition never became true");
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it("a final emitted after an abrupt disconnect still lands in the one finalized transcript", async () => {
    const finalized: { name: string; segments: { text: string }[] }[] = [];
    const { providers, port, token } = start((t) => finalized.push(t));
    const ws = new WebSocket(`ws://127.0.0.1:${port}/stream?token=${token}`);
    await new Promise((r) => ws.on("open", r));
    await until(() => providers.length === 1);

    let resolveClose!: () => void;
    providers[0]!.closeBarrier = new Promise((r) => {
      resolveClose = r;
    });

    ws.terminate(); // abrupt: no finish handshake, no waiting for the final
    // Let the server's close handler run and call session.close().
    await until(() => providers[0]!.closed);

    // The true final arrives in the window the close is waiting through.
    providers[0]!.emitTranscript({ text: "the true final", isFinal: true });
    resolveClose();

    await until(() => finalized.length === 1);
    expect(finalized[0]!.segments.map((s) => s.text)).toEqual(["the true final"]);
    const files = jsonlFiles(transcriptsDir!);
    expect(files).toHaveLength(1); // no orphaned second transcript file
    expect(files[0]!.replace(/\.jsonl$/, "")).toBe(finalized[0]!.name);
  });

  it("an abrupt disconnect whose provider close hangs still finalizes once it resolves, and only once", async () => {
    const finalized: { name: string }[] = [];
    const { providers, port, token } = start((t) => finalized.push(t));
    const ws = new WebSocket(`ws://127.0.0.1:${port}/stream?token=${token}`);
    await new Promise((r) => ws.on("open", r));
    await until(() => providers.length === 1);

    // A final already on disk before the disconnect, so finalize has an
    // entry to hand to the hook.
    providers[0]!.emitTranscript({ text: "before the drop", isFinal: true });
    await until(() => jsonlFiles(transcriptsDir!).length === 1);

    let resolveClose!: () => void;
    providers[0]!.closeBarrier = new Promise((r) => {
      resolveClose = r;
    });

    ws.terminate();
    await until(() => providers[0]!.closed);
    // While the provider's close is pending, nothing has been finalized yet.
    await new Promise((r) => setTimeout(r, 30));
    expect(finalized).toHaveLength(0);

    resolveClose(); // the provider's own bound elapsing, in production
    await until(() => finalized.length === 1);
    expect(jsonlFiles(transcriptsDir!)).toHaveLength(1);
  });
});
