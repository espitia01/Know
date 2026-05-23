import type {
  Assumption,
  CrossPaperQA,
  Note,
  ParsedPaper,
  PaperSummary,
  PreReadingAnalysis,
  QAItem,
  SelectionAnalysisResult,
} from "@/lib/api";

export type ExportSectionId =
  | "summary"
  | "qa"
  | "notes"
  | "selection"
  | "assumptions"
  | "figures"
  | "cross"
  | "related"
  | "prepare";

function hasSummaryContent(summary: PaperSummary | null | undefined): boolean {
  if (!summary) return false;
  return !!(
    summary.overview?.trim() ||
    summary.motivation?.trim() ||
    summary.methodology?.trim() ||
    summary.main_results?.trim() ||
    summary.discussion?.trim() ||
    summary.future_work?.trim() ||
    (summary.key_contributions?.length ?? 0) > 0 ||
    (summary.limitations?.length ?? 0) > 0 ||
    (summary.key_equations?.length ?? 0) > 0 ||
    (summary.key_figures_and_tables?.length ?? 0) > 0
  );
}

function hasPreReadingContent(pr: PreReadingAnalysis | null | undefined): boolean {
  if (!pr) return false;
  return (
    (pr.definitions?.length ?? 0) > 0 ||
    (pr.research_questions?.length ?? 0) > 0 ||
    (pr.concepts?.length ?? 0) > 0
  );
}

function hasRelatedContent(
  pr: PreReadingAnalysis | null | undefined,
  cache: ParsedPaper["cached_analysis"],
): boolean {
  const prior = pr?.prior_work?.length ?? 0;
  const topics = pr?.prior_work_topics?.length ?? 0;
  const raw = cache as Record<string, unknown> | undefined;
  const citedRaw = raw?.cited_by;
  const citedBy = Array.isArray(citedRaw)
    ? citedRaw.length
    : Array.isArray((citedRaw as { items?: unknown[] } | undefined)?.items)
      ? (citedRaw as { items: unknown[] }).items.length
      : 0;
  return prior > 0 || topics > 0 || citedBy > 0;
}

type AvailabilitySnap = {
  papersById: Record<string, ParsedPaper>;
  summaryByPaper: Record<string, PaperSummary | null>;
  preReadingByPaper: Record<string, PreReadingAnalysis | null>;
  assumptionsByPaper: Record<string, Assumption[]>;
  notesByPaper: Record<string, Note[]>;
  selectionHistoryByPaper: Record<string, SelectionAnalysisResult[]>;
  qaResultsByPaper: Record<string, QAItem[]>;
  crossPaperResults: CrossPaperQA[];
};

/** Which export sections have content for this paper in the current session. */
export function getExportSectionAvailability(
  paperId: string,
  snap: AvailabilitySnap,
): Record<ExportSectionId, boolean> {
  const paper = snap.papersById[paperId];
  const cache = paper?.cached_analysis;

  const summary =
    snap.summaryByPaper[paperId] ??
    (cache?.summary_lite as PaperSummary | undefined) ??
    (cache?.summary_deep as PaperSummary | undefined) ??
    (cache?.summary as PaperSummary | undefined);

  const preReading =
    snap.preReadingByPaper[paperId] ?? (cache?.pre_reading as PreReadingAnalysis | undefined);

  const qaLive = snap.qaResultsByPaper[paperId]?.length ?? 0;
  const qaCached = Array.isArray(cache?.qa_sessions)
    ? cache!.qa_sessions!.reduce(
        (acc, session) =>
          acc + (Array.isArray(session?.items) ? session.items.length : 0),
        0,
      )
    : 0;

  const notesLive = snap.notesByPaper[paperId]?.length ?? 0;
  const notesCached = paper?.notes?.length ?? 0;

  const selectionLive = snap.selectionHistoryByPaper[paperId]?.length ?? 0;
  const selectionCached = Array.isArray(cache?.selections) ? cache!.selections!.length : 0;

  const assumptionsLive = snap.assumptionsByPaper[paperId]?.length ?? 0;
  const assumptionsCached = cache?.assumptions?.assumptions?.length ?? 0;

  const figureMeta = paper?.figures?.length ?? 0;
  const figureAnalyses = Array.isArray(cache?.figure_analyses) ? cache!.figure_analyses!.length : 0;

  const crossLive = snap.crossPaperResults.length;
  const cacheRaw = cache as Record<string, unknown> | undefined;
  const crossCached = Array.isArray(cacheRaw?.cross_paper_qa) ? cacheRaw!.cross_paper_qa!.length : 0;

  return {
    summary: hasSummaryContent(summary),
    qa: qaLive + qaCached > 0,
    notes: notesLive + notesCached > 0,
    selection: selectionLive + selectionCached > 0,
    assumptions: assumptionsLive + assumptionsCached > 0,
    figures: figureMeta + figureAnalyses > 0,
    cross: crossLive + crossCached > 0,
    related: hasRelatedContent(preReading, cache),
    prepare: hasPreReadingContent(preReading),
  };
}
