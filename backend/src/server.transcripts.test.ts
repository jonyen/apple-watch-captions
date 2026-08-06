import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { AddressInfo } from "net";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { startServer, CaptionServer } from "./server";
import { FakeTranscriptionProvider } from "./fakeTranscriptionProvider";
import {
  TranscriptStore,
  writeSummary,
  writeExportMarker,
  listTranscripts,
} from "./transcriptStore";

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
    providers[0].emitTranscript({ text: "hello", isFinal: true, channel: 0 });
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
    expect(detail.segments[0].channel).toBe(0);
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

  it("deletes a transcript so it drops off the listing", async () => {
    const { providers, port } = start("good");
    await fetch(`${base(port)}/v1/audio?session=s1&token=good`, { method: "POST" });
    providers[0].emitTranscript({ text: "hello", isFinal: true });
    const name = listTranscripts(dir)[0].name;

    const res = await fetch(`${base(port)}/v1/transcripts/${name}?token=good`, {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: name });
    const list = await (await fetch(`${base(port)}/v1/transcripts?token=good`)).json();
    expect(list.transcripts).toEqual([]);
  });

  it("404s deleting an unknown transcript", async () => {
    const { port } = start("good");
    const res = await fetch(`${base(port)}/v1/transcripts/nope?token=good`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
    // Asserting the body, not just the status: the unrouted fallback also
    // answers 404, so a bare status check would pass without the route.
    expect(await res.json()).toEqual({ error: "not found" });
  });

  it("rejects a delete without a valid token", async () => {
    const { providers, port } = start("good");
    await fetch(`${base(port)}/v1/audio?session=s1&token=good`, { method: "POST" });
    providers[0].emitTranscript({ text: "hello", isFinal: true });
    const name = listTranscripts(dir)[0].name;
    const url = `${base(port)}/v1/transcripts/${name}`;

    expect((await fetch(url, { method: "DELETE" })).status).toBe(401);
    expect((await fetch(`${url}?token=bad`, { method: "DELETE" })).status).toBe(401);

    expect(listTranscripts(dir)).toHaveLength(1);
  });

  // The watch polls this after a session ends so it can notify once the
  // transcript is in Notion. Deliberately not the detail endpoint: polling that
  // ships every caption back over a cellular watch link each time.
  describe("export status", () => {
    /** Comfortably past the content floor below which nothing is exported. */
    const SUBSTANTIAL = "we talked for a while about the release schedule";

    async function storedTranscript(
      port: number,
      providers: FakeTranscriptionProvider[],
      text = SUBSTANTIAL,
    ) {
      await fetch(`${base(port)}/v1/audio?session=s1&token=good`, { method: "POST" });
      providers[0].emitTranscript({ text, isFinal: true });
      return listTranscripts(dir)[0].name;
    }

    it("reports a transcript that has not reached Notion", async () => {
      const { providers, port } = start("good");
      const name = await storedTranscript(port, providers);

      const res = await fetch(`${base(port)}/v1/transcripts/${name}/export?token=good`);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ exported: false, eligible: true });
    });

    // Without this a client cannot tell "not yet" from "never", and waits out
    // its whole window on a transcript the relay already decided to skip.
    it("reports a transcript below the content floor as ineligible", async () => {
      const { providers, port } = start("good");
      const name = await storedTranscript(port, providers, "hello");

      const res = await fetch(`${base(port)}/v1/transcripts/${name}/export?token=good`);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ exported: false, eligible: false });
    });

    it("reports the page once the transcript has been exported", async () => {
      const { providers, port } = start("good");
      const name = await storedTranscript(port, providers);
      writeSummary(dir, name, "Title: Sprint planning\n\nWe planned the sprint.");
      writeExportMarker(dir, name, { pageId: "p1", url: "https://notion.so/p1" });

      const res = await fetch(`${base(port)}/v1/transcripts/${name}/export?token=good`);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.exported).toBe(true);
      expect(body.eligible).toBe(true);
      expect(body.url).toBe("https://notion.so/p1");
      // Carries the title so the watch's notification can say what it was
      // about without a second round trip.
      expect(body.title).toBe("Sprint planning");
      expect(body.exportedAt).toEqual(expect.any(String));
    });

    it("404s export status for an unknown transcript", async () => {
      const { port } = start("good");
      const res = await fetch(`${base(port)}/v1/transcripts/nope/export?token=good`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not found" });
    });

    it("rejects export status without a valid token", async () => {
      const { providers, port } = start("good");
      const name = await storedTranscript(port, providers);
      const url = `${base(port)}/v1/transcripts/${name}/export`;

      expect((await fetch(url)).status).toBe(401);
      expect((await fetch(`${url}?token=bad`)).status).toBe(401);
    });
  });

  it("serves the viewer page without a token", async () => {
    const { port } = start("good");
    const res = await fetch(`${base(port)}/app`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Transcripts");
  });
});
