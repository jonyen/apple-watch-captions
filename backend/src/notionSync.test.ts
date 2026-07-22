import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createNotionSync, notionPageIdFor, recordNotionPage } from "./notionSync";
import { FinalizedTranscript } from "./transcriptStore";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

function fakeFetch(): { calls: Call[]; fetchImpl: typeof fetch; failWith?: () => void } {
  const calls: Call[] = [];
  let fail = false;
  const fetchImpl = (async (url: any, init: any) => {
    calls.push({
      url: String(url),
      method: init.method,
      headers: init.headers,
      body: JSON.parse(init.body),
    });
    if (fail) {
      return { ok: false, status: 401, text: async () => "unauthorized" } as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: "page-123" }),
      text: async () => "",
    } as Response;
  }) as typeof fetch;
  return {
    calls,
    fetchImpl,
    failWith: () => {
      fail = true;
    },
  };
}

function transcript(texts: string[], channels?: (number | undefined)[]): FinalizedTranscript {
  return {
    name: "2026-07-06T01-02-03Z_abc",
    sessionId: "abc",
    startedAt: "2026-07-06T01:02:03Z",
    endedAt: "2026-07-06T01:05:03Z",
    segments: texts.map((text, i) => ({
      at: "2026-07-06T01:02:05Z",
      text,
      ...(channels?.[i] !== undefined ? { channel: channels[i] } : {}),
    })),
  };
}

describe("createNotionSync", () => {
  it("creates a database page with title, summary and transcript blocks", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const sync = createNotionSync({ apiKey: "secret", databaseId: "db-1", fetchImpl });

    const pageId = await sync(transcript(["hello there", "second line"]), "Overview.\n- a point");

    expect(pageId).toBe("page-123");
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.url).toBe("https://api.notion.com/v1/pages");
    expect(call.method).toBe("POST");
    expect(call.headers.Authorization).toBe("Bearer secret");
    expect(call.headers["Notion-Version"]).toBeDefined();
    expect(call.body.parent).toEqual({ database_id: "db-1" });
    expect(call.body.properties.title.title[0].text.content).toBe(
      "2026-07-06 01:02 — hello there second line",
    );

    const types = call.body.children.map((b: any) => b.type);
    expect(types).toEqual(["heading_2", "paragraph", "paragraph", "heading_2", "paragraph", "paragraph"]);
    expect(call.body.children[0].heading_2.rich_text[0].text.content).toBe("Summary");
    expect(call.body.children[4].paragraph.rich_text[0].text.content).toBe("01:02:05 hello there");
  });

  it("labels channels the way the summarizer does", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const sync = createNotionSync({ apiKey: "k", databaseId: "db", fetchImpl });

    await sync(transcript(["mine", "theirs"], [0, 1]), null);

    const paragraphs = calls[0].body.children.slice(1); // after the Transcript heading
    expect(paragraphs[0].paragraph.rich_text[0].text.content).toBe("01:02:05 Me: mine");
    expect(paragraphs[1].paragraph.rich_text[0].text.content).toBe("01:02:05 Them: theirs");
  });

  it("omits the Summary section when there is no summary", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const sync = createNotionSync({ apiKey: "k", databaseId: "db", fetchImpl });

    await sync(transcript(["hello"]), null);

    const headings = calls[0].body.children
      .filter((b: any) => b.type === "heading_2")
      .map((b: any) => b.heading_2.rich_text[0].text.content);
    expect(headings).toEqual(["Transcript"]);
  });

  it("appends blocks beyond Notion's 100-per-request limit in batches", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const sync = createNotionSync({ apiKey: "k", databaseId: "db", fetchImpl });

    // 1 heading + 250 paragraphs = 251 blocks → 100 on create, then 100 + 51.
    await sync(transcript(Array.from({ length: 250 }, (_, i) => `caption ${i}`)), null);

    expect(calls).toHaveLength(3);
    expect(calls[0].body.children).toHaveLength(100);
    expect(calls[1].url).toBe("https://api.notion.com/v1/blocks/page-123/children");
    expect(calls[1].method).toBe("PATCH");
    expect(calls[1].body.children).toHaveLength(100);
    expect(calls[2].body.children).toHaveLength(51);
    const last = calls[2].body.children.at(-1);
    expect(last.paragraph.rich_text[0].text.content).toContain("caption 249");
  });

  it("splits text longer than 2000 chars across rich text chunks", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const sync = createNotionSync({ apiKey: "k", databaseId: "db", fetchImpl });

    await sync(transcript(["x".repeat(4500)]), null);

    const chunks = calls[0].body.children[1].paragraph.rich_text;
    expect(chunks).toHaveLength(3);
    expect(chunks[0].text.content).toHaveLength(2000);
    expect(chunks.map((c: any) => c.text.content).join("")).toContain("x".repeat(4500));
  });

  it("throws on a non-ok Notion response", async () => {
    const { fetchImpl, failWith } = fakeFetch();
    failWith!();
    const sync = createNotionSync({ apiKey: "bad", databaseId: "db", fetchImpl });

    await expect(sync(transcript(["hello"]), null)).rejects.toThrow(/401/);
  });
});

describe("sync markers", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "notion-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips the synced page id", () => {
    expect(notionPageIdFor(dir, "t1")).toBeNull();
    recordNotionPage(dir, "t1", "page-9");
    expect(notionPageIdFor(dir, "t1")).toBe("page-9");
    expect(notionPageIdFor(dir, "t2")).toBeNull();
  });
});
