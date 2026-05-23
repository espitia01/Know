import { describe, expect, it } from "vitest";
import { getExportSectionAvailability } from "@/lib/exportSectionAvailability";

describe("getExportSectionAvailability", () => {
  const emptySnap = {
    papersById: {},
    summaryByPaper: {},
    preReadingByPaper: {},
    assumptionsByPaper: {},
    notesByPaper: {},
    selectionHistoryByPaper: {},
    qaResultsByPaper: {},
    crossPaperResults: [],
  };

  it("detects nested assumptions in cached_analysis", () => {
    const paperId = "p1";
    const snap = {
      ...emptySnap,
      papersById: {
        [paperId]: {
          id: paperId,
          title: "Test",
          cached_analysis: {
            assumptions: {
              assumptions: [{ statement: "x", type: "explicit", section: "intro" }],
            },
          },
        },
      },
    };
    const avail = getExportSectionAvailability(paperId, snap as never);
    expect(avail.assumptions).toBe(true);
  });

  it("counts Q&A items not empty session shells", () => {
    const paperId = "p1";
    const snap = {
      ...emptySnap,
      papersById: {
        [paperId]: {
          id: paperId,
          title: "Test",
          cached_analysis: {
            qa_sessions: [{ items: [{ question: "Q?", answer: "A." }] }],
          },
        },
      },
    };
    const avail = getExportSectionAvailability(paperId, snap as never);
    expect(avail.qa).toBe(true);
  });
});
