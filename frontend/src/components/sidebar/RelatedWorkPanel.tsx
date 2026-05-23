"use client";

import { useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { AnalysisSection } from "@/components/analysis/AnalysisSection";
import { AnalysisProgress } from "@/components/ui/AnalysisProgress";
import { EmptyState } from "@/components/ui/EmptyState";
import { clearProgressStart, markRequestStart, markRequestEnd } from "@/lib/analysisState";
import { dedupePriorWork, referenceListItems } from "@/lib/formatBibliography";
import { ReferenceBibliographyList } from "@/components/sidebar/ReferenceBibliographyList";

interface RelatedWorkPanelProps {
  paperId: string;
}

const RELATED_TAB_INTRO =
  "Bibliography entries parsed from the paper. Tap a row to open DOI, arXiv, PubMed, or Scholar when available.";

export function RelatedWorkPanel({ paperId }: RelatedWorkPanelProps) {
  const preReading = useStore((s) => s.preReadingByPaper[paperId] ?? null);
  const setPreReadingForPaper = useStore((s) => s.setPreReadingForPaper);
  const updateCachedAnalysis = useStore((s) => s.updateCachedAnalysis);
  const preReadingLoading = useStore(
    (s) => s.preReadingLoadingByPaper[paperId] ?? false,
  );
  const setPreReadingLoadingForPaper = useStore(
    (s) => s.setPreReadingLoadingForPaper,
  );
  const currentPaperRef = useRef(paperId);
  currentPaperRef.current = paperId;
  const [loadError, setLoadError] = useState<string | null>(null);

  const handleRunPrepare = async () => {
    const targetId = paperId;
    setLoadError(null);
    clearProgressStart(targetId, "preReading");
    markRequestStart(targetId, "preReading");
    setPreReadingLoadingForPaper(targetId, true);
    try {
      const result = await api.analyze(targetId);
      setPreReadingForPaper(targetId, result);
      updateCachedAnalysis(targetId, { pre_reading: result });
    } catch (e) {
      console.error("Prepare analysis failed:", e);
      if (currentPaperRef.current === targetId) {
        setLoadError(e instanceof Error ? e.message : "Prepare failed. Try again.");
      }
    } finally {
      markRequestEnd(targetId, "preReading");
      clearProgressStart(targetId, "preReading");
      setPreReadingLoadingForPaper(targetId, false);
    }
  };

  const priorList = useMemo(
    () => dedupePriorWork(referenceListItems(preReading?.prior_work ?? [])),
    [preReading?.prior_work],
  );

  const rawPriorCount = preReading?.prior_work?.length ?? 0;
  const filteredNote =
    rawPriorCount > 0 && priorList.length > 0 && priorList.length < rawPriorCount
      ? `Showing ${priorList.length} clean entries (${rawPriorCount} raw rows parsed from the PDF).`
      : null;

  if (preReadingLoading) {
    return (
      <div className="space-y-3 py-8 motion-safe:animate-fade-in">
        <p className="text-[var(--text-xs)] leading-relaxed text-muted-foreground">{RELATED_TAB_INTRO}</p>
        <div className="flex min-h-[32vh] flex-col items-center justify-center gap-3">
          <div className="w-full max-w-xs">
            <AnalysisProgress kind="preReading" paperId={paperId} />
          </div>
          <p className="text-[var(--text-sm)] text-muted-foreground">Extracting bibliography…</p>
        </div>
      </div>
    );
  }

  if (!preReading || rawPriorCount === 0) {
    return (
      <div className="space-y-4 motion-safe:animate-fade-in">
        <p className="text-[var(--text-xs)] leading-relaxed text-muted-foreground">{RELATED_TAB_INTRO}</p>
        <EmptyState
          title={preReading ? "No related citations parsed" : "Related work not loaded"}
          body={
            loadError ||
            (preReading
              ? "Prepare couldn't isolate a numbered bibliography in this PDF. Re-run it when references are selectable as text."
              : "Run Prepare to extract cited works from this paper's bibliography.")
          }
          cta={{ label: loadError ? "Retry Prepare" : "Run Prepare", onClick: handleRunPrepare }}
        />
      </div>
    );
  }

  if (priorList.length === 0) {
    return (
      <div className="space-y-4 motion-safe:animate-fade-in">
        <p className="text-[var(--text-xs)] leading-relaxed text-muted-foreground">{RELATED_TAB_INTRO}</p>
        <EmptyState
          title="References need a refresh"
          body="Prepare found bibliography rows, but none passed cleanup yet. Re-run Prepare to rebuild the list with the latest parser."
          cta={{ label: "Re-run Prepare", onClick: handleRunPrepare }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-8 motion-safe:animate-fade-in">
      <p className="text-[var(--text-xs)] leading-relaxed text-muted-foreground">{RELATED_TAB_INTRO}</p>

      <AnalysisSection title="References" count={priorList.length}>
        {filteredNote ? (
          <p className="mb-2 text-[var(--text-xs)] text-muted-foreground/80">{filteredNote}</p>
        ) : null}
        <ReferenceBibliographyList items={priorList} />
      </AnalysisSection>

      <div>
        <button
          type="button"
          onClick={handleRunPrepare}
          className="text-[var(--text-xs)] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          Refresh from Prepare…
        </button>
      </div>
    </div>
  );
}
