import { describe, expect, it } from "vitest";
import {
  tablesFromPaper,
  codeBlocksFromPaper,
  tableBodyMarkdown,
} from "@/lib/ocrArtifacts";
import type { ParsedPaper } from "@/lib/api";

const basePaper = (markdown: string): ParsedPaper => ({
  id: "p1",
  title: "Test",
  authors: [],
  raw_text: "",
  markdown,
  figures: [],
  has_si: false,
  folder: "",
  tags: [],
  notes: [],
  cached_analysis: {},
});

describe("ocrArtifacts", () => {
  it("extracts pipe tables with captions and dedupes caption-only duplicates", () => {
    const md = `Table 1. Scores on Atari

We compare to CQL and other baselines in the main text.

| Game | DT (Ours) | CQL |
| --- | --- | --- |
| Breakout | 100 | 80 |

| Game | DT (Ours) | CQL |
| --- | --- | --- |
| Breakout | 100 | 80 |`;
    const tables = tablesFromPaper(basePaper(md));
    expect(tables).toHaveLength(1);
    expect(tables[0].label).toMatch(/Table 1/i);
    expect(tableBodyMarkdown(tables[0].markdown)).toContain("Breakout");
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

  it("extracts unfenced Algorithm pseudocode blocks", () => {
    const md = `Algorithm 1 Decision Transformer Pseudocode (for continuous actions)
# R , s , a , t : returns - to - go
def DecisionTransformer (R , s , a , t ):
    pos_embedding = embed_t ( t )
    return pred_a ( a_hidden )
# training loop
for (R , s , a , t ) in dataloader :
    loss = mean (( a_preds - a )**2)
    optimizer . step ()
5

Table 2. Results

| A | B |
| --- | --- |
| 1 | 2 |`;
    const blocks = codeBlocksFromPaper(basePaper(md));
    const alg = blocks.find((b) => b.id === "algorithm-1");
    expect(alg).toBeDefined();
    expect(alg?.language).toBe("pseudocode");
    expect(alg?.code).toContain("DecisionTransformer");
    expect(alg?.context).toMatch(/Algorithm 1/i);
  });
});
