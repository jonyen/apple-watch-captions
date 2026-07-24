import { describe, it, expect } from "vitest";
import { markdownToBlocks, MAX_TEXT } from "./notionBlocks";

/** Text of a block, joining its rich_text runs. */
function textOf(block: any): string {
  const body = block[block.type];
  return body.rich_text.map((r: any) => r.text.content).join("");
}

describe("markdownToBlocks", () => {
  it("turns a line of prose into a paragraph", () => {
    const blocks = markdownToBlocks("A chat about the roadmap.");

    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("paragraph");
    expect(textOf(blocks[0])).toBe("A chat about the roadmap.");
  });

  it("maps ## to heading_2", () => {
    const blocks = markdownToBlocks("## Action items");

    expect(blocks[0].type).toBe("heading_2");
    expect(textOf(blocks[0])).toBe("Action items");
  });

  it("maps # and ### to their heading levels", () => {
    expect(markdownToBlocks("# Top")[0].type).toBe("heading_1");
    expect(markdownToBlocks("### Deep")[0].type).toBe("heading_3");
  });

  it("maps - and * lines to bulleted list items", () => {
    const blocks = markdownToBlocks("- first point\n* second point");

    expect(blocks.map((b) => b.type)).toEqual(["bulleted_list_item", "bulleted_list_item"]);
    expect(blocks.map(textOf)).toEqual(["first point", "second point"]);
  });

  it("drops blank lines", () => {
    const blocks = markdownToBlocks("One.\n\n\nTwo.");

    expect(blocks).toHaveLength(2);
    expect(blocks.map(textOf)).toEqual(["One.", "Two."]);
  });

  it("splits a paragraph past Notion's per-text limit without losing words", () => {
    const word = "alpha ";
    const long = word.repeat(600).trim(); // ~3600 chars

    const blocks = markdownToBlocks(long);

    expect(blocks.length).toBeGreaterThan(1);
    for (const block of blocks) {
      expect(block.type).toBe("paragraph");
      expect(textOf(block).length).toBeLessThanOrEqual(MAX_TEXT);
    }
    expect(blocks.map(textOf).join(" ")).toBe(long);
  });

  it("splits a run of non-whitespace that cannot break on a word", () => {
    const long = "x".repeat(MAX_TEXT + 500);

    const blocks = markdownToBlocks(long);

    expect(blocks.map(textOf).join("")).toBe(long);
    for (const block of blocks) expect(textOf(block).length).toBeLessThanOrEqual(MAX_TEXT);
  });

  it("returns nothing for empty or whitespace-only markdown", () => {
    expect(markdownToBlocks("")).toEqual([]);
    expect(markdownToBlocks("   \n\n ")).toEqual([]);
  });
});
