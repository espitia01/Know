"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { api, type PriorWork } from "@/lib/api";
import { useStore } from "@/lib/store";
import { AnalysisSection } from "@/components/analysis/AnalysisSection";
import { StreamingMarkdown } from "@/components/analysis/StreamingMarkdown";
import { AnalysisProgress } from "@/components/ui/AnalysisProgress";
import { EmptyState } from "@/components/ui/EmptyState";
import { clearProgressStart, markRequestStart, markRequestEnd } from "@/lib/analysisState";
import { scholarSearchHrefFromPriorWork } from "@/lib/priorWorkLinks";
import {
  sanitizeCitationForDisplay,
  sanitizeRelatedClusterSummaryMarkdown,
} from "@/lib/formatBibliography";

interface RelatedWorkPanelProps {
  paperId: string;
}

const RELATED_TAB_INTRO =
  "Tap a citation to search Google Scholar. Reference lines come from this paper’s bibliography when we can extract them.";

function showThemeHeading(t: string): boolean {
  const s = (t || "").trim();
  if (!s) return false;
  if (/^other\s+references?$/i.test(s)) return false;
  return true;
}

function CitationIndex({ n }: { n: number }) {
  return (
    <span
      className="mt-px shrink-0 w-6 text-right text-[var(--text-xs)] tabular-nums text-muted-foreground/70"
      aria-hidden
    >
      {n}.
    </span>
  );
}

function VerbatimCitationLink({ work }: { work: PriorWork }) {
  const scholarHref = scholarSearchHrefFromPriorWork(work);
  const raw =
    (typeof work.citation_display === "string" && work.citation_display.trim()) ||
    work.title.trim() ||
    "Reference";
  const display = sanitizeCitationForDisplay(raw);
  const linkCls =
    "block text-[var(--text-sm)] leading-relaxed text-foreground/90 underline decoration-border underline-offset-[3px] hover:decoration-foreground/60 text-pretty hyphens-auto [overflow-wrap:anywhere]";

  if (scholarHref) {
    return (
      <a href={scholarHref} target="_blank" rel="noopener noreferrer" className={linkCls}>
        {display}
      </a>
    );
  }
  return (
    <span className="block text-[var(--text-sm)] leading-relaxed text-foreground/90 text-pretty hyphens-auto [overflow-wrap:anywhere]">
      {display}
    </span>
  );
}

function CitationList({
  items,
  startIndex = 0,
}: {
  items: PriorWork[];
  startIndex?: number;
}) {
  return (
    <ol className="mt-3 list-none space-y-2 p-0">
      {items.map((p, i) => (
        <li key={`${p.bib_label ?? p.title}-${startIndex + i}`} className="flex items-start gap-2.5">
          <CitationIndex n={startIndex + i + 1} />
          <div className="min-w-0 flex-1 pt-px">
            <VerbatimCitationLink work={p} />
          </div>
        </li>
      ))}
    </ol>
  );
}

export function RelatedWorkPanel({ paperId }: RelatedWorkPanelProps) {
  const preReading = useStore(
    useCallback(
      (s) => (s.preReadingPaperId === paperId ? s.preReading : null),
      [paperId],
    ),
  );
  const setPreReading = useStore((s) => s.setPreReading);
  const updateCachedAnalysis = useStore((s) => s.updateCachedAnalysis);
  const preReadingLoading = useStore((s) => s.preReadingLoading);
  const setPreReadingLoading = useStore((s) => s.setPreReadingLoading);
  const currentPaperRef = useRef(paperId);
  currentPaperRef.current = paperId;
  const [loadError, setLoadError] = useState<string | null>(null);

  const handleRunPrepare = async () => {
    const targetId = paperId;
    setLoadError(null);
    clearProgressStart(targetId, "preReading");
    markRequestStart(targetId, "preReading");
    setPreReadingLoading(true);
    try {
      const result = await api.analyze(targetId);
      if (currentPaperRef.current === targetId) {
        setPreReading(targetId, result);
        updateCachedAnalysis(targetId, { pre_reading: result });
      }
    } catch (e) {
      console.error("Prepare analysis failed:", e);
      if (currentPaperRef.current === targetId) {
        setLoadError(e instanceof Error ? e.message : "Prepare failed. Try again.");
      }
    } finally {
      markRequestEnd(targetId, "preReading");
      clearProgressStart(targetId, "preReading");
      if (currentPaperRef.current === targetId) setPreReadingLoading(false);
    }
  };

  const topicalClusters = useMemo(() => {
    if (!preReading) return null;
    const pts = preReading.prior_work_topics;
    const hasItems =
      Array.isArray(pts) && pts.some((t) => (t.items?.length ?? 0) > 0);
    return hasItems ? pts!.filter((t) => (t.items?.length ?? 0) > 0) : null;
  }, [preReading]);

  const clusterGlobalStarts = useMemo(() => {
    if (!topicalClusters?.length) return [];
    let acc = 0;
    return topicalClusters.map((sec) => {
      const base = acc;
      acc += sec.items?.length ?? 0;
      return base;
    });
  }, [topicalClusters]);

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

  const priorList = preReading?.prior_work ?? [];

  if (!preReading || priorList.length === 0) {
    return (
      <div className="space-y-4 motion-safe:animate-fade-in">
        <p className="text-[var(--text-xs)] leading-relaxed text-muted-foreground">{RELATED_TAB_INTRO}</p>
        <EmptyState
          title={preReading ? "No related citations parsed" : "Related work not loaded"}
          body={
            loadError ||
            (preReading
              ? "Prepare couldn’t isolate a numbered bibliography in this PDF. Re-run it when references are selectable as text."
              : "Run Prepare to extract cited works from this paper’s bibliography.")
          }
          cta={{ label: loadError ? "Retry Prepare" : "Run Prepare", onClick: handleRunPrepare }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-8 motion-safe:animate-fade-in">
      <p className="text-[var(--text-xs)] leading-relaxed text-muted-foreground">{RELATED_TAB_INTRO}</p>
      {topicalClusters?.length ? (
        topicalClusters.map((sec, si) => {
          const items = sec.items ?? [];
          const theme = (sec.theme ?? "").trim();
          const summary = (sec.summary || "").trim();
          const title = showThemeHeading(theme) ? theme : "References";
          return (
            <AnalysisSection key={`cluster-${si}`} title={title} count={items.length}>
              {summary ? (
                <div className="[&_.analysis-content]:text-[var(--text-sm)] [&_.analysis-content]:leading-relaxed">
                  <StreamingMarkdown>
                    {sanitizeRelatedClusterSummaryMarkdown(summary)}
                  </StreamingMarkdown>
                </div>
              ) : null}
              <CitationList items={items} startIndex={clusterGlobalStarts[si] ?? 0} />
            </AnalysisSection>
          );
        })
      ) : (
        <AnalysisSection title="References" count={priorList.length}>
          <CitationList items={priorList} />
        </AnalysisSection>
      )}

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
