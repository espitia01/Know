import { describe, expect, it } from "vitest";
import { tablesFromPaper, codeBlocksFromPaper } from "@/lib/ocrArtifacts";
import type { ParsedPaper } from "@/lib/api";

const basePaper = (markdown: string): ParsedPaper => ({
  id: "p1",
  title: "Test",
  raw_text: "",
  markdown,
  figures: [],
  folder: "",
  tags: [],
  notes: [],
  cached_analysis: {},
});

describe("ocrArtifacts", () => {
  it("extracts pipe tables with captions", () => {
    const md = `Table 1. Scores

| A | B |
| --- | --- |
| 1 | 2 |`;
    const tables = tablesFromPaper(basePaper(md));
    expect(tables).toHaveLength(1);
    expect(tables[0].label).toMatch(/Table 1/i);
    expect(tables[0].markdown).toContain("| 1 | 2 |");
  });

  it("extracts fenced code blocks", () => {
    const md = `## Method

\`\`\`python
def train():
    return 1
\`\`\``;
    const blocks = codeBlocksFromPaper(basePaper(md));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].language).toBe("python");
    expect(blocks[0].code).toContain("def train");
  });
});
