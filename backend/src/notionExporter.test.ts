import { describe, it, expect, vi } from "vitest";
import { createNotionExporter, createNotionSummaryPatcher } from "./notionExporter";
import { FinalizedTranscript } from "./transcriptStore";

const DB_ID = "db-123";

function transcript(overrides: Partial<FinalizedTranscript> = {}): FinalizedTranscript {
  return {
    name: "2026-07-06T01-02-03Z_abc",
    sessionId: "abc",
    startedAt: "2026-07-06T01:02:03Z",
    endedAt: "2026-07-06T01:05:03Z",
    segments: [
      { at: "2026-07-06T01:02:03Z", text: "hello there" },
      { at: "2026-07-06T01:02:09Z", text: "how are you" },
    ],
    ...overrides,
  };
}

interface Call {
  url: string;
  method: string;
  body: any;
  headers: Record<string, string>;
}

/** Fake Notion API: records calls, answers with plausible payloads. */
function fakeNotion(opts: { properties?: Record<string, { type: string }> } = {}) {
  const calls: Call[] = [];
  const properties = opts.properties ?? {
    Name: { type: "title" },
    Started: { type: "date" },
    Ended: { type: "date" },
    Segments: { type: "number" },
    Session: { type: "rich_text" },
  };
  let appended = 0;

  const fetch = vi.fn(async (url: string, init: any) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined, headers: init?.headers ?? {} });

    if (url.includes("/databases/")) {
      return json({ id: DB_ID, properties });
    }
    if (url.endsWith("/pages")) {
      return json({ id: "page-1", url: "https://notion.so/page-1" });
    }
    // Appending children echoes back the blocks it created.
    const body = JSON.parse(init.body);
    return json({
      results: body.children.map(() => ({ id: `block-${++appended}` })),
    });
  });

  return { fetch, calls };
}

function json(body: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Blocks sent across every request, in order. */
function allBlocks(calls: Call[]): any[] {
  return calls.flatMap((c) => c.body?.children ?? []);
}

function textOf(block: any): string {
  return block[block.type].rich_text.map((r: any) => r.text.content).join("");
}

/** The "Full transcript" toggle, now that pages carry a Summary toggle too. */
function transcriptToggle(calls: Call[]): any {
  return allBlocks(calls).find(
    (b) => b.type === "toggle" && b.toggle.rich_text[0].text.content === "Full transcript",
  );
}

describe("createNotionExporter", () => {
  it("creates a page in the configured database and returns its id and url", async () => {
    const notion = fakeNotion();
    const exporter = createNotionExporter({ token: "secret-tok", databaseId: DB_ID, fetch: notion.fetch });

    const result = await exporter(transcript(), "A short chat.");

    expect(result).toEqual({ pageId: "page-1", url: "https://notion.so/page-1" });
    const create = notion.calls.find((c) => c.url.endsWith("/pages"))!;
    expect(create.method).toBe("POST");
    expect(create.body.parent).toEqual({ database_id: DB_ID });
  });

  it("authenticates every request with the token and an API version", async () => {
    const notion = fakeNotion();
    const exporter = createNotionExporter({ token: "secret-tok", databaseId: DB_ID, fetch: notion.fetch });

    await exporter(transcript(), "A short chat.");

    expect(notion.calls.length).toBeGreaterThan(0);
    for (const call of notion.calls) {
      expect(call.headers.Authorization).toBe("Bearer secret-tok");
      expect(call.headers["Notion-Version"]).toBeTruthy();
    }
  });

  it("titles the page with the session's start time", async () => {
    const notion = fakeNotion();
    const exporter = createNotionExporter({ token: "t", databaseId: DB_ID, fetch: notion.fetch });

    await exporter(transcript(), null);

    const create = notion.calls.find((c) => c.url.endsWith("/pages"))!;
    const title = create.body.properties.Name.title[0].text.content;
    expect(title).toContain("2026-07-06");
  });

  it("uses whatever the database calls its title property", async () => {
    const notion = fakeNotion({ properties: { Session: { type: "title" } } });
    const exporter = createNotionExporter({ token: "t", databaseId: DB_ID, fetch: notion.fetch });

    await exporter(transcript(), null);

    const create = notion.calls.find((c) => c.url.endsWith("/pages"))!;
    expect(create.body.properties.Session.title).toBeTruthy();
    expect(create.body.properties.Name).toBeUndefined();
  });

  it("fills optional properties the database defines", async () => {
    const notion = fakeNotion();
    const exporter = createNotionExporter({ token: "t", databaseId: DB_ID, fetch: notion.fetch });

    await exporter(transcript(), null);

    const props = notion.calls.find((c) => c.url.endsWith("/pages"))!.body.properties;
    expect(props.Started.date.start).toBe("2026-07-06T01:02:03Z");
    expect(props.Ended.date.start).toBe("2026-07-06T01:05:03Z");
    expect(props.Segments.number).toBe(2);
  });

  it("omits properties the database does not define", async () => {
    const notion = fakeNotion({ properties: { Name: { type: "title" } } });
    const exporter = createNotionExporter({ token: "t", databaseId: DB_ID, fetch: notion.fetch });

    await exporter(transcript(), null);

    const props = notion.calls.find((c) => c.url.endsWith("/pages"))!.body.properties;
    expect(Object.keys(props)).toEqual(["Name"]);
  });

  it("puts the summary in its own toggle, separate from the transcript", async () => {
    const notion = fakeNotion();
    const exporter = createNotionExporter({ token: "t", databaseId: DB_ID, fetch: notion.fetch });

    await exporter(transcript(), "An overview.\n\n## Action items\n- ship it");

    const toggles = allBlocks(notion.calls).filter((b) => b.type === "toggle");
    const titles = toggles.map((t) => t.toggle.rich_text[0].text.content);
    expect(titles).toEqual(["Summary", "Full transcript"]);

    const summary = toggles[0].toggle.children;
    expect(summary.map(textOf)).toEqual(["An overview.", "Action items", "ship it"]);
    expect(summary.map((b: any) => b.type)).toEqual([
      "paragraph",
      "heading_2",
      "bulleted_list_item",
    ]);
  });

  it("omits the summary toggle when there is no summary", async () => {
    const notion = fakeNotion();
    const exporter = createNotionExporter({ token: "t", databaseId: DB_ID, fetch: notion.fetch });

    await exporter(transcript(), null);

    const toggles = allBlocks(notion.calls).filter((b) => b.type === "toggle");
    expect(toggles.map((t) => t.toggle.rich_text[0].text.content)).toEqual(["Full transcript"]);
  });

  it("appends summary blocks past the request limit into the summary toggle", async () => {
    const notion = fakeNotion();
    const exporter = createNotionExporter({ token: "t", databaseId: DB_ID, fetch: notion.fetch });
    const longSummary = Array.from({ length: 150 }, (_, i) => `point ${i}`).join("\n");

    await exporter(transcript(), longSummary);

    const sent = allBlocks(notion.calls);
    const summaryToggle = sent.find(
      (b) => b.type === "toggle" && b.toggle.rich_text[0].text.content === "Summary",
    )!;
    expect(summaryToggle.toggle.children.length).toBeLessThanOrEqual(100);

    const all = [...summaryToggle.toggle.children, ...sent.filter((b) => b.type === "paragraph")];
    const points = all.map(textOf).filter((t) => t.startsWith("point "));
    expect(points.length).toBe(150);
  });

  it("puts the transcript lines in a toggle", async () => {
    const notion = fakeNotion();
    const exporter = createNotionExporter({ token: "t", databaseId: DB_ID, fetch: notion.fetch });

    await exporter(transcript(), "A short chat.");

    const toggle = transcriptToggle(notion.calls);
    expect(toggle).toBeDefined();
    expect(toggle.toggle.children.map(textOf)).toEqual(["hello there", "how are you"]);
  });

  it("labels channel-tagged segments as Me and Them", async () => {
    const notion = fakeNotion();
    const exporter = createNotionExporter({ token: "t", databaseId: DB_ID, fetch: notion.fetch });

    await exporter(
      transcript({
        segments: [
          { at: "2026-07-06T01:02:03Z", text: "my line", channel: 0 },
          { at: "2026-07-06T01:02:09Z", text: "their line", channel: 1 },
        ],
      }),
      null,
    );

    const toggle = transcriptToggle(notion.calls);
    expect(toggle.toggle.children.map(textOf)).toEqual(["Me: my line", "Them: their line"]);
  });

  it("appends transcript lines past the 100-block request limit to the toggle", async () => {
    const notion = fakeNotion();
    const exporter = createNotionExporter({ token: "t", databaseId: DB_ID, fetch: notion.fetch });
    const segments = Array.from({ length: 250 }, (_, i) => ({
      at: "2026-07-06T01:02:03Z",
      text: `line ${i}`,
    }));

    await exporter(transcript({ segments }), null);

    const sent = allBlocks(notion.calls);
    const toggle = transcriptToggle(notion.calls);
    expect(toggle.toggle.children.length).toBeLessThanOrEqual(100);

    // Every line lands somewhere: inside the toggle or in a follow-up append.
    const lines = [...toggle.toggle.children, ...sent.filter((b) => b.type === "paragraph")].map(textOf);
    expect(lines).toContain("line 0");
    expect(lines).toContain("line 249");
    expect(lines.filter((t) => t.startsWith("line ")).length).toBe(250);

    // The overflow is nested under the toggle, not dumped at page level.
    const appends = notion.calls.filter((c) => c.url.includes("/blocks/") && c.method === "PATCH");
    expect(appends.length).toBeGreaterThan(1);
    expect(appends.at(-1)!.url).toContain("block-");
  });

  it("throws with the API's status and message when a request fails", async () => {
    const fetch = vi.fn(async (url: string) =>
      url.includes("/databases/")
        ? json({ properties: { Name: { type: "title" } } })
        : json({ code: "object_not_found", message: "Could not find database" }, 404),
    );
    const exporter = createNotionExporter({ token: "t", databaseId: DB_ID, fetch: fetch as any });

    await expect(exporter(transcript(), null)).rejects.toThrow(/404.*Could not find database/s);
  });

  it("exports a transcript that was never summarized", async () => {
    const notion = fakeNotion();
    const exporter = createNotionExporter({ token: "t", databaseId: DB_ID, fetch: notion.fetch });

    const result = await exporter(transcript(), null);

    expect(result.pageId).toBe("page-1");
    expect(transcriptToggle(notion.calls)).toBeDefined();
  });

  it("retries the schema lookup after it fails, instead of caching the failure", async () => {
    const notion = fakeNotion();
    let schemaCalls = 0;
    const fetch = vi.fn(async (url: string, init: any) => {
      // Notion is down for the first schema lookup only.
      if (url.includes("/databases/") && ++schemaCalls === 1) {
        return json({ message: "service unavailable" }, 503);
      }
      return notion.fetch(url, init);
    });
    const exporter = createNotionExporter({ token: "t", databaseId: DB_ID, fetch: fetch as any });

    await expect(exporter(transcript(), null)).rejects.toThrow(/503/);

    // A later export must be able to succeed once Notion recovers.
    await expect(exporter(transcript(), null)).resolves.toMatchObject({ pageId: "page-1" });
  });

  it("adds a Summary toggle to an existing page without creating a new one", async () => {
    const notion = fakeNotion();
    const patch = createNotionSummaryPatcher({ token: "t", databaseId: DB_ID, fetch: notion.fetch });

    await patch("page-9", "An overview.\n- ship it");

    expect(notion.calls.find((c) => c.url.endsWith("/pages"))).toBeUndefined();
    const append = notion.calls.find((c) => c.url.includes("/blocks/page-9/children"))!;
    expect(append.method).toBe("PATCH");

    const toggle = append.body.children[0];
    expect(toggle.type).toBe("toggle");
    expect(toggle.toggle.rich_text[0].text.content).toBe("Summary");
    expect(toggle.toggle.children.map(textOf)).toEqual(["An overview.", "ship it"]);
  });

  it("throws when the page update fails, so the caller can report it", async () => {
    const fetch = vi.fn(async () => json({ message: "Could not find block" }, 404));
    const patch = createNotionSummaryPatcher({ token: "t", databaseId: DB_ID, fetch: fetch as any });

    await expect(patch("page-9", "An overview.")).rejects.toThrow(/404/);
  });

  it("looks up the database schema once across exports", async () => {
    const notion = fakeNotion();
    const exporter = createNotionExporter({ token: "t", databaseId: DB_ID, fetch: notion.fetch });

    await exporter(transcript(), null);
    await exporter(transcript(), null);

    expect(notion.calls.filter((c) => c.url.includes("/databases/"))).toHaveLength(1);
  });
});
