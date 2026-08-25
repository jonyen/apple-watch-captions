import { describe, it, expect, afterEach } from "vitest";
import { AddressInfo } from "net";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { startServer, CaptionServer } from "./server";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";
import { TranscriptStore, FinalizedTranscript } from "./transcriptStore";
import { TrainingCapture } from "./trainingCapture";
import { IdentityStore } from "./identityStore";
import { openDb } from "./db";

// End-to-end coverage of TRAINING_CAPTURE_DIR through the real HTTP /v1/audio
// + /v1/stop transport: SessionStore.feed → CaptionSession.handleAudio →
// TrainingCapture.audio, and TranscriptStore.finalize → its onFinalize hook →
// TrainingCapture.finalize, wired the same way `serverOptions.ts` wires them
// in production.

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

function startWithCapture() {
  transcriptsDir = mkdtempSync(join(tmpdir(), "transcripts-capture-"));
  captureDir = mkdtempSync(join(tmpdir(), "training-capture-"));
  const identity = new IdentityStore(openDb(":memory:"));
  const device = identity.registerDevice("watch");
  const providers: FakeTranscriptionProvider[] = [];
  const trainingCapture = new TrainingCapture({ dir: captureDir });
  const transcripts = new TranscriptStore({
    root: transcriptsDir,
    onFinalize: (t: FinalizedTranscript) => trainingCapture.finalize(t),
  });
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
    transcriptionProvider: "apple",
  });
  running = server;
  const port = (server.address() as AddressInfo).port;
  return { providers, port, token: device.token };
}

function audioUrl(port: number, query: string) {
  return `http://127.0.0.1:${port}/v1/audio?${query}`;
}

function postAudio(port: number, query: string, token: string, body: Buffer) {
  return fetch(audioUrl(port, query), {
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

describe("TRAINING_CAPTURE_DIR wired through /v1/audio", () => {
  it("saves audio.wav, transcript.txt, and meta.json when the session has audio and finals", async () => {
    const { providers, port, token } = startWithCapture();

    await postAudio(port, "session=t1", token, Buffer.from("some pcm bytes"));
    providers[0]!.emitTranscript({ text: "hello there", isFinal: true });
    await stop(port, "t1", token);

    const dirs = readdirSync(captureDir!, { withFileTypes: true }).filter(
      (e) => e.isDirectory() && e.name !== ".staging",
    );
    expect(dirs).toHaveLength(1);
    const dir = join(captureDir!, dirs[0]!.name);

    const wav = readFileSync(join(dir, "audio.wav"));
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.readUInt32LE(40)).toBe(Buffer.from("some pcm bytes").length);

    expect(readFileSync(join(dir, "transcript.txt"), "utf8")).toBe("hello there\n");

    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
    expect(meta.provider).toBe("apple");
    expect(typeof meta.createdAt).toBe("string");
    expect(typeof meta.durationSeconds).toBe("number");
  });

  it("captures nothing for a caption-only session", async () => {
    const { port, token } = startWithCapture();

    await fetch(`http://127.0.0.1:${port}/v1/captions?session=t2`, {
      method: "POST",
      headers: { ...authHeaders(token), "content-type": "application/json" },
      body: JSON.stringify({ lines: [{ text: "typed by the client.", isFinal: true }] }),
    });
    await stop(port, "t2", token);

    expect(
      readdirSync(captureDir!, { withFileTypes: true }).filter(
        (e) => e.isDirectory() && e.name !== ".staging",
      ),
    ).toEqual([]);
  });

  it("cleans up a session that sent audio but ended with zero final lines", async () => {
    const { port, token } = startWithCapture();

    await postAudio(port, "session=t3", token, Buffer.from("audio with no finals"));
    await stop(port, "t3", token); // never emits a transcript

    expect(
      readdirSync(captureDir!, { withFileTypes: true }).filter(
        (e) => e.isDirectory() && e.name !== ".staging",
      ),
    ).toEqual([]);
    expect(existsSync(join(captureDir!, ".staging"))).toBe(true);
    expect(readdirSync(join(captureDir!, ".staging"))).toEqual([]);
  });

  it("does not capture an ephemeral session's audio", async () => {
    const { providers, port, token } = startWithCapture();

    await postAudio(port, "session=t4&ephemeral=1", token, Buffer.from("off the record"));
    providers[0]!.emitTranscript({ text: "shh", isFinal: true });
    await stop(port, "t4", token);

    expect(
      readdirSync(captureDir!, { withFileTypes: true }).filter(
        (e) => e.isDirectory() && e.name !== ".staging",
      ),
    ).toEqual([]);
  });
});

describe("no TRAINING_CAPTURE_DIR configured", () => {
  it("writes nothing and behaves exactly as before", async () => {
    transcriptsDir = mkdtempSync(join(tmpdir(), "transcripts-nocapture-"));
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
      // trainingCapture intentionally omitted
    });
    running = server;
    const port = (server.address() as AddressInfo).port;

    const res = await postAudio(port, "session=t1", device.token, Buffer.from("pcm"));
    expect(res.status).toBe(200);
    providers[0]!.emitTranscript({ text: "fine", isFinal: true });
    await stop(port, "t1", device.token);
    // Nothing to assert on disk — there is no capture directory at all,
    // which is the point: the feature must not exist unless configured.
  });
});
