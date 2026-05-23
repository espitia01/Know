"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api, type CitedByItem } from "@/lib/api";
import { useStore } from "@/lib/store";
import { AnalysisSection } from "@/components/analysis/AnalysisSection";
import { AnalysisProgress } from "@/components/ui/AnalysisProgress";
import { EmptyState } from "@/components/ui/EmptyState";
import { clearProgressStart, markRequestStart, markRequestEnd } from "@/lib/analysisState";
import { dedupePriorWork, referenceListItems } from "@/lib/formatBibliography";
import { CitationGraph } from "@/components/sidebar/CitationGraph";
import { ReferenceBibliographyList } from "@/components/sidebar/ReferenceBibliographyList";

interface RelatedWorkPanelProps {
  paperId: string;
}

const RELATED_TAB_INTRO =
  "Bibliography entries match the Cited by format below. Tap a row to open DOI, arXiv, PubMed, or Scholar when available.";

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
  const [citedBy, setCitedBy] = useState<CitedByItem[]>([]);
  const [citedLoading, setCitedLoading] = useState(false);
  const [citedError, setCitedError] = useState<string | null>(null);
  const paperTitle = useStore((s) => s.paper?.id === paperId ? (s.paper?.title ?? "") : "");

  useEffect(() => {
    let cancelled = false;
    setCitedLoading(true);
    setCitedError(null);
    void api.getCitedBy(paperId).then((res) => {
      if (cancelled) return;
      setCitedBy(res.items ?? []);
      if (res.error === "s2_not_found") setCitedError("not_found");
      setCitedLoading(false);
    }).catch(() => {
      if (cancelled) return;
      setCitedError("fetch_failed");
      setCitedLoading(false);
    });
    return () => { cancelled = true; };
  }, [paperId]);

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

  const topics = useMemo(() => preReading?.prior_work_topics ?? [], [preReading?.prior_work_topics]);
  const rawPriorCount = preReading?.prior_work?.length ?? 0;

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

  const graphAvailable = priorList.length > 0 || citedBy.length > 0 || topics.length > 0;

  return (
    <div className="space-y-8 motion-safe:animate-fade-in">
      <p className="text-[var(--text-xs)] leading-relaxed text-muted-foreground">{RELATED_TAB_INTRO}</p>

      {graphAvailable && (
        <CitationGraph
          paperTitle={paperTitle}
          outbound={priorList}
          inbound={citedBy}
          topics={topics}
        />
      )}

      <AnalysisSection title="References" count={priorList.length}>
        <ReferenceBibliographyList items={priorList} />
      </AnalysisSection>

      <AnalysisSection title="Cited by" count={citedBy.length}>
        {citedLoading ? (
          <p className="text-[var(--text-sm)] text-muted-foreground">Loading citing papers…</p>
        ) : citedError === "not_found" ? (
          <EmptyState title="Couldn't find this paper on Semantic Scholar." body="" />
        ) : citedBy.length === 0 ? (
          <EmptyState title="No known papers cite this one yet." body="" />
        ) : (
          <ol className="mt-3 list-none space-y-2.5 p-0">
            {citedBy.map((item, i) => {
              const authors = (item.authors ?? []).slice(0, 3).join(", ");
              const href =
                (item.doi ? `https://doi.org/${item.doi}` : "") ||
                (item.arxiv ? `https://arxiv.org/abs/${item.arxiv}` : "") ||
                item.url ||
                (item.s2_id ? `https://www.semanticscholar.org/paper/${item.s2_id}` : "");
              const label = `${authors}${authors ? " " : ""}(${item.year ?? "n.d."}) — ${item.title}`;
              return (
                <li key={item.s2_id || item.title} className="flex items-start gap-2.5">
                  <span
                    className="mt-px shrink-0 w-6 text-right text-[var(--text-xs)] tabular-nums text-muted-foreground/70"
                    aria-hidden
                  >
                    {i + 1}.
                  </span>
                  <div className="min-w-0 flex-1 pt-px text-[var(--text-sm)] leading-relaxed text-foreground/90">
                    {href ? (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline-offset-[3px] hover:underline decoration-border/60"
                      >
                        {label}
                      </a>
                    ) : (
                      label
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
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
