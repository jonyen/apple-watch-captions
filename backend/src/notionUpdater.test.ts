import { describe, it, expect, vi } from "vitest";
import { createNotionUpdater } from "./notionUpdater";
import { FinalizedTranscript } from "./transcriptStore";

const DB_ID = "db-123";
const PAGE = "page-1";

function transcript(count: number): FinalizedTranscript {
  return {
    name: "2026-07-06T01-02-03Z_abc",
    sessionId: "abc",
    startedAt: "2026-07-06T01:02:03Z",
    endedAt: "2026-07-06T01:05:03Z",
    resumed: true,
    segments: Array.from({ length: count }, (_, i) => ({
      at: "2026-07-06T01:02:03Z",
      text: `line ${i}`,
    })),
  };
}

interface Call {
  url: string;
  method: string;
  body: any;
}

function json(body: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Fake Notion holding one page with the two toggles a prior export created. */
function fakeNotion(opts: { toggles?: string[] } = {}) {
  const toggles = opts.toggles ?? ["Summary", "Full transcript"];
  const calls: Call[] = [];
  let appended = 0;

  const fetch = vi.fn(async (url: string, init: any) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });

    if (url.includes("/databases/")) {
      return json({ id: DB_ID, properties: { Name: { type: "title" } } });
    }
    if (url.includes(`/blocks/${PAGE}/children`) && method === "GET") {
      return json({
        results: toggles.map((title, i) => ({
          id: `existing-${i}`,
          type: "toggle",
          toggle: { rich_text: [{ plain_text: title, text: { content: title } }] },
        })),
      });
    }
    if (method === "DELETE") return json({ id: url.split("/blocks/")[1], archived: true });
    if (url.includes("/pages/")) return json({ id: PAGE });
    return json({ results: (body?.children ?? []).map(() => ({ id: `new-${++appended}` })) });
  });

  return { fetch, calls };
}

const textOf = (b: any) => b[b.type].rich_text.map((r: any) => r.text.content).join("");
const find = (calls: Call[], pred: (c: Call) => boolean) => calls.filter(pred);

describe("createNotionUpdater", () => {
  it("replaces the stale Summary toggle with a fresh one", async () => {
    const notion = fakeNotion();
    const update = createNotionUpdater({ token: "t", databaseId: DB_ID, fetch: notion.fetch });

    await update(transcript(3), "Title: New topic\n\nA fresher overview.", {
      pageId: PAGE,
      url: "u",
      exportedSegments: 3,
    });

    // The old Summary toggle is archived...
    const deletes = find(notion.calls, (c) => c.method === "DELETE");
    expect(deletes.map((c) => c.url.split("/blocks/")[1])).toEqual(["existing-0"]);

    // ...and a new one is appended in its place.
    const appendedSummary = notion.calls
      .flatMap((c) => c.body?.children ?? [])
      .find((b: any) => b.type === "toggle" && textOf(b) === "Summary");
    expect(appendedSummary.toggle.children.map(textOf)).toEqual(["A fresher overview."]);
  });

  it("appends only the segments the page does not already have", async () => {
    const notion = fakeNotion();
    const update = createNotionUpdater({ token: "t", databaseId: DB_ID, fetch: notion.fetch });

    await update(transcript(5), "Title: T\n\nBody.", {
      pageId: PAGE,
      url: "u",
      exportedSegments: 3,
    });

    // Lines 3 and 4 are new; 0-2 were already on the page.
    const intoTranscript = find(
      notion.calls,
      (c) => c.method === "PATCH" && c.url.includes("/blocks/existing-1/children"),
    );
    const texts = intoTranscript.flatMap((c) => c.body.children.map(textOf));
    expect(texts).toEqual(["line 3", "line 4"]);
  });

  it("retitles the page, since a resumed session may have moved on", async () => {
    const notion = fakeNotion();
    const update = createNotionUpdater({ token: "t", databaseId: DB_ID, fetch: notion.fetch });

    await update(transcript(4), "Title: Moved on to billing\n\nBody.", {
      pageId: PAGE,
      url: "u",
      exportedSegments: 2,
    });

    const patch = notion.calls.find((c) => c.url.endsWith(`/pages/${PAGE}`))!;
    expect(patch.body.properties.Name.title[0].text.content).toBe(
      "2026-07-06 01:02 — Moved on to billing",
    );
  });

  it("reports how much of the transcript is now on the page", async () => {
    const notion = fakeNotion();
    const update = createNotionUpdater({ token: "t", databaseId: DB_ID, fetch: notion.fetch });

    const result = await update(transcript(7), "Title: T\n\nBody.", {
      pageId: PAGE,
      url: "u",
      exportedSegments: 2,
    });

    expect(result.exportedSegments).toBe(7);
  });

  it("treats a missing exportedSegments count as nothing exported yet", async () => {
    // Markers written before resume existed carry no count.
    const notion = fakeNotion();
    const update = createNotionUpdater({ token: "t", databaseId: DB_ID, fetch: notion.fetch });

    await update(transcript(2), "Title: T\n\nBody.", { pageId: PAGE, url: "u" });

    const texts = find(
      notion.calls,
      (c) => c.method === "PATCH" && c.url.includes("/blocks/existing-1/children"),
    ).flatMap((c) => c.body.children.map(textOf));
    expect(texts).toEqual(["line 0", "line 1"]);
  });

  it("still adds a summary when the page has no Summary toggle to replace", async () => {
    const notion = fakeNotion({ toggles: ["Full transcript"] });
    const update = createNotionUpdater({ token: "t", databaseId: DB_ID, fetch: notion.fetch });

    await update(transcript(1), "Title: T\n\nBody.", {
      pageId: PAGE,
      url: "u",
      exportedSegments: 1,
    });

    expect(find(notion.calls, (c) => c.method === "DELETE")).toHaveLength(0);
    const summary = notion.calls
      .flatMap((c) => c.body?.children ?? [])
      .find((b: any) => b.type === "toggle" && textOf(b) === "Summary");
    expect(summary).toBeDefined();
  });

  it("appends a transcript toggle when the page somehow has none", async () => {
    const notion = fakeNotion({ toggles: [] });
    const update = createNotionUpdater({ token: "t", databaseId: DB_ID, fetch: notion.fetch });

    await update(transcript(2), "Title: T\n\nBody.", { pageId: PAGE, url: "u" });

    const toggles = notion.calls
      .flatMap((c) => c.body?.children ?? [])
      .filter((b: any) => b.type === "toggle")
      .map(textOf);
    expect(toggles).toContain("Full transcript");
  });

  it("throws with the API status when the page cannot be read", async () => {
    const fetch = vi.fn(async (url: string) =>
      url.includes("/databases/")
        ? json({ properties: { Name: { type: "title" } } })
        : json({ message: "Could not find block" }, 404),
    );
    const update = createNotionUpdater({ token: "t", databaseId: DB_ID, fetch: fetch as any });

    await expect(
      update(transcript(1), "Title: T\n\nBody.", { pageId: PAGE, url: "u" }),
    ).rejects.toThrow(/404/);
  });
});
