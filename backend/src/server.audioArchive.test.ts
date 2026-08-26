import { describe, it, expect, afterEach } from "vitest";
import { AddressInfo } from "net";
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { startServer, CaptionServer } from "./server";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";
import { TranscriptStore } from "./transcriptStore";
import { TrainingCapture } from "./trainingCapture";
import { IdentityStore } from "./identityStore";
import { openDb } from "./db";

// End-to-end coverage of POST /v1/audio-archive — the storage-only path a
// kept-on-device session streams its raw PCM to, alongside (never instead
// of) the captions it already uploads via /v1/captions. No transcription
// provider is ever opened against this audio; it is labeled offline, after
// the fact, once the session finalizes.

let running: CaptionServer | null = null;
let transcriptsDir: string | null = null;
let captureDir: string | null = null;

afterEach(async () => {
  if (running) await running.close();
  running = null;
  if (transcriptsDir) rmSync(transcriptsDir, { recursive: true, force: true });
  if (captureDir) rmSync(captureDir, { recursive: true, force: true });
  transcriptsDir = null;
  captureDir = null;
});

function authHeaders(token: string) {
  return { authorization: `Bearer ${token}` };
}

function startWithCapture(transcribeOffline?: (wavPath: string) => Promise<string[]>) {
  transcriptsDir = mkdtempSync(join(tmpdir(), "transcripts-archive-"));
  captureDir = mkdtempSync(join(tmpdir(), "training-archive-"));
  const identity = new IdentityStore(openDb(":memory:"));
  const device = identity.registerDevice("watch");
  const providers: FakeTranscriptionProvider[] = [];
  const trainingCapture = new TrainingCapture({
    dir: captureDir,
    transcribeOffline: transcribeOffline ?? (async () => ["offline label"]),
  });
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
    trainingCapture,
  });
  running = server;
  const port = (server.address() as AddressInfo).port;
  return { providers, port, token: device.token };
}

function postArchive(port: number, session: string, token: string, body: Buffer) {
  return fetch(`http://127.0.0.1:${port}/v1/audio-archive?session=${session}`, {
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

function postCaptions(port: number, session: string, token: string, lines: unknown[]) {
  return fetch(`http://127.0.0.1:${port}/v1/captions?session=${session}`, {
    method: "POST",
    headers: { ...authHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({ lines }),
  });
}

function captureDirs(): string[] {
  return readdirSync(captureDir!, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== ".staging")
    .map((e) => e.name);
}

describe("POST /v1/audio-archive", () => {
  it("archives PCM and, on stop, writes audio.wav + offline-labeled transcript.txt/meta.json", async () => {
    const { port, token } = startWithCapture();
    const res = await postArchive(port, "a1", token, Buffer.from("some raw pcm"));
    expect(res.status).toBe(200);

    await stop(port, "a1", token);

    const dirs = captureDirs();
    expect(dirs).toHaveLength(1);
    const dir = join(captureDir!, dirs[0]!);
    const wav = readFileSync(join(dir, "audio.wav"));
    expect(wav.readUInt32LE(40)).toBe(Buffer.from("some raw pcm").length);
    expect(readFileSync(join(dir, "transcript.txt"), "utf8")).toBe("offline label\n");
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    expect(meta.provider).toBe("apple-offline");
  });

  it("never opens a transcription provider for the archived audio", async () => {
    const { providers, port, token } = startWithCapture();
    await postArchive(port, "a2", token, Buffer.from("pcm"));
    await stop(port, "a2", token);
    // The offline labeler uses its own provider, created lazily only inside
    // TrainingCapture.archiveFinalize via createOfflineLabeler's factory —
    // never through SessionStore.createProvider, which this test's fixture
    // tracks. So no provider from *this* factory should ever have been made.
    expect(providers).toHaveLength(0);
  });

  it("also captures archived audio alongside a session's normal caption uploads, without those captions ever reaching the training dir", async () => {
    const { port, token } = startWithCapture();
    await postCaptions(port, "a3", token, [{ text: "kept caption.", isFinal: true }]);
    await postArchive(port, "a3", token, Buffer.from("pcm for a3"));
    await stop(port, "a3", token);

    // The visible transcript history got the caption text.
    const userDir = join(transcriptsDir!, readdirSync(transcriptsDir!)[0]!);
    const jsonl = readdirSync(userDir).find((f) => f.endsWith(".jsonl"))!;
    const segments = readFileSync(join(userDir, jsonl), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(segments.map((s: any) => s.text)).toEqual(["kept caption."]);

    // The training dir got only the archived audio, never the caption text.
    const dirs = captureDirs();
    expect(dirs).toHaveLength(1);
    const dir = join(captureDir!, dirs[0]!);
    expect(readFileSync(join(dir, "audio.wav")).readUInt32LE(40)).toBe(
      Buffer.from("pcm for a3").length,
    );
  });

  it("keeps the audio when offline labeling fails, and never loses it", async () => {
    const { port, token } = startWithCapture(async () => {
      throw new Error("sidecar unreachable");
    });
    await postArchive(port, "a4", token, Buffer.from("pcm"));
    await stop(port, "a4", token);

    const dirs = captureDirs();
    expect(dirs).toHaveLength(1);
    const dir = join(captureDir!, dirs[0]!);
    expect(existsSync(join(dir, "audio.wav"))).toBe(true);
    expect(existsSync(join(dir, "transcript.txt"))).toBe(false);
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    expect(meta.labelsPending).toBe(true);
  });

  it("rejects with a clear error when training capture is disabled", async () => {
    transcriptsDir = mkdtempSync(join(tmpdir(), "transcripts-archive-off-"));
    const identity = new IdentityStore(openDb(":memory:"));
    const device = identity.registerDevice("watch");
    const server = startServer({
      port: 0,
      identity,
      createProvider: () => new FakeTranscriptionProvider(),
      transcripts: new TranscriptStore({ root: transcriptsDir }),
      transcriptsRoot: transcriptsDir,
      // trainingCapture intentionally omitted
    });
    running = server;
    const port = (server.address() as AddressInfo).port;

    const res = await postArchive(port, "a5", device.token, Buffer.from("pcm"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
  });

  it("rejects an unauthenticated request", async () => {
    const { port } = startWithCapture();
    const res = await postArchive(port, "a6", "not-a-real-token", Buffer.from("pcm"));
    expect(res.status).toBe(401);
  });

  it("answers an unauthenticated request 401 even when training capture is disabled (never leaks the capability via 404)", async () => {
    transcriptsDir = mkdtempSync(join(tmpdir(), "transcripts-archive-off-auth-"));
    const identity = new IdentityStore(openDb(":memory:"));
    const server = startServer({
      port: 0,
      identity,
      createProvider: () => new FakeTranscriptionProvider(),
      transcripts: new TranscriptStore({ root: transcriptsDir }),
      transcriptsRoot: transcriptsDir,
      // trainingCapture intentionally omitted
    });
    running = server;
    const port = (server.address() as AddressInfo).port;

    // An unauthorized probe must not be able to tell a capture-disabled
    // relay (404) apart from a capture-enabled one (401): auth is checked
    // first, so both answer 401.
    const res = await postArchive(port, "a7", "not-a-real-token", Buffer.from("pcm"));
    expect(res.status).toBe(401);
  });
});
