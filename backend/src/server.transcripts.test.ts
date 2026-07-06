import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { AddressInfo } from "net";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { startServer, CaptionServer } from "./server";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";
import { TranscriptStore, writeSummary, listTranscripts } from "./transcriptStore";

let running: CaptionServer | null = null;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "transcripts-http-"));
});
afterEach(async () => {
  if (running) await running.close();
  running = null;
  rmSync(dir, { recursive: true, force: true });
});

function start(authToken: string) {
  const providers: FakeTranscriptionProvider[] = [];
  const server = startServer({
    port: 0,
    authToken,
    createProvider: () => {
      const p = new FakeTranscriptionProvider();
      providers.push(p);
      return p;
    },
    transcripts: new TranscriptStore({ dir }),
    transcriptsDir: dir,
  });
  running = server;
  const port = (server.address() as AddressInfo).port;
  return { providers, port };
}

const base = (port: number) => `http://127.0.0.1:${port}`;

describe("transcript persistence + endpoints", () => {
  it("persists final captions from a session and serves them back", async () => {
    const { providers, port } = start("good");
    await fetch(`${base(port)}/v1/audio?session=s1&token=good`, { method: "POST" });
    providers[0].emitReady();
    providers[0].emitTranscript({ text: "hello", isFinal: true });
    providers[0].emitTranscript({ text: "interim", isFinal: false }); // not persisted
    providers[0].emitTranscript({ text: "world", isFinal: true });

    const list = await (
      await fetch(`${base(port)}/v1/transcripts?token=good`)
    ).json();
    expect(list.transcripts).toHaveLength(1);
    expect(list.transcripts[0].segmentCount).toBe(2);

    const detail = await (
      await fetch(`${base(port)}/v1/transcripts/${list.transcripts[0].name}?token=good`)
    ).json();
    expect(detail.segments.map((s: { text: string }) => s.text)).toEqual(["hello", "world"]);
    expect(detail.summary).toBeNull();
  });

  it("includes a stored summary in the detail response", async () => {
    const { providers, port } = start("good");
    await fetch(`${base(port)}/v1/audio?session=s1&token=good`, { method: "POST" });
    providers[0].emitTranscript({ text: "hello", isFinal: true });
    const name = listTranscripts(dir)[0].name;
    writeSummary(dir, name, "Short chat.");

    const detail = await (
      await fetch(`${base(port)}/v1/transcripts/${name}?token=good`)
    ).json();
    expect(detail.summary).toBe("Short chat.");
  });

  it("rejects transcript requests without a valid token", async () => {
    const { port } = start("good");
    expect((await fetch(`${base(port)}/v1/transcripts`)).status).toBe(401);
    expect((await fetch(`${base(port)}/v1/transcripts?token=bad`)).status).toBe(401);
  });

  it("404s an unknown transcript", async () => {
    const { port } = start("good");
    const res = await fetch(`${base(port)}/v1/transcripts/nope?token=good`);
    expect(res.status).toBe(404);
  });

  it("serves the viewer page without a token", async () => {
    const { port } = start("good");
    const res = await fetch(`${base(port)}/app`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Transcripts");
  });
});
