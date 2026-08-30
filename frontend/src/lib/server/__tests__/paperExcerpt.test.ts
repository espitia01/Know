import { describe, expect, it } from "vitest";
import { buildPaperExcerpt } from "../paperExcerpt";

const LONG_PAPER = [
  "# Title",
  "",
  "## Abstract",
  "This paper studies widgets in depth. ".repeat(40),
  "",
  "## Introduction",
  "We introduce the problem. ".repeat(30),
  "",
  "## Methods",
  "Our methodology uses regression and controls for confounders. ".repeat(80),
  "",
  "## Results",
  "We find a significant effect size of 0.42 with p < 0.01. ".repeat(80),
  "",
  "## Discussion",
  "These results imply broader applicability. ".repeat(20),
  "",
  "## Conclusion",
  "Future work should replicate in other domains. ".repeat(15),
].join("\n");

describe("buildPaperExcerpt", () => {
  it("includes Methods and Results bodies for summary profile", () => {
    const out = buildPaperExcerpt(LONG_PAPER, { maxChars: 20000, profile: "summary" });
    expect(out).toContain("Methods");
    expect(out).toContain("Results");
    expect(out).toContain("regression");
    expect(out).toContain("effect size");
  });

  it("includes Methods for the selection profile so later equations survive", () => {
    const out = buildPaperExcerpt(LONG_PAPER, { maxChars: 20000, profile: "selection" });
    expect(out).toContain("Methods");
    expect(out).toContain("regression");
  });

  it("falls back to head slice when no headings", () => {
    const raw = "x".repeat(10000);
    const max = 500;
    const out = buildPaperExcerpt(raw, { maxChars: max, profile: "summary" });
    expect(out).toBe(raw.slice(0, max));
  });
});
