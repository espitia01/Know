import { describe, expect, it } from "vitest";
import type { ParsedPaper, PaperSummary } from "@/lib/api";
import {
  paperHasFiguresOrTables,
  paperLikelyHasEquations,
  summaryKeyEquations,
  summaryKeyFiguresAndTables,
} from "@/lib/summarySections";

const basePaper = {
  id: "p1",
  title: "Test",
  authors: [],
  raw_text: "",
  figures: [],
  has_si: false,
  folder: "",
  tags: [],
  notes: [],
  cached_analysis: {},
} satisfies ParsedPaper;

describe("paperLikelyHasEquations", () => {
  it("returns false when paper metadata is missing", () => {
    expect(paperLikelyHasEquations(null)).toBe(false);
  });

  it("detects display math", () => {
    expect(
      paperLikelyHasEquations({
        ...basePaper,
        raw_text: "We derive $$E = mc^2$$ from first principles.",
      }),
    ).toBe(true);
  });

  it("ignores a single dollar sign in prose", () => {
    expect(
      paperLikelyHasEquations({
        ...basePaper,
        raw_text: "The grant was $5000 and the result was not significant.",
      }),
    ).toBe(false);
  });
});

describe("paperHasFiguresOrTables", () => {
  it("returns false when paper metadata is missing", () => {
    expect(paperHasFiguresOrTables(null)).toBe(false);
  });

  it("detects extracted figures", () => {
    expect(
      paperHasFiguresOrTables({
        ...basePaper,
        figures: [{ id: "fig-1", page: 1, caption: "Plot", url: "/fig.png" }],
      }),
    ).toBe(true);
  });

  it("detects figure references in text", () => {
    expect(
      paperHasFiguresOrTables({
        ...basePaper,
        raw_text: "As shown in Fig. 2, the trend increases.",
      }),
    ).toBe(true);
  });
});

describe("summary optional sections", () => {
  it("filters placeholder figure rows", () => {
    const summary = {
      key_figures_and_tables: [
        { id: "N/A", description: "No figures" },
        { id: "Fig. 1", description: "Main result" },
      ],
    } satisfies Partial<PaperSummary>;
    expect(summaryKeyFiguresAndTables(summary)).toEqual([
      { id: "Fig. 1", description: "Main result" },
    ]);
  });

  it("filters empty equation rows", () => {
    const summary = {
      key_equations: [
        { equation: "", meaning: "" },
        { equation: "$$x=1$$", meaning: "Definition" },
      ],
    } satisfies Partial<PaperSummary>;
    expect(summaryKeyEquations(summary)).toEqual([
      { equation: "$$x=1$$", meaning: "Definition" },
    ]);
  });
});
