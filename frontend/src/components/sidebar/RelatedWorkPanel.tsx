"use client";

import { useCallback, useRef, useState } from "react";
import { api, type PriorWork } from "@/lib/api";
import { useStore } from "@/lib/store";
import { Md } from "@/components/ui/Md";
import { AnalysisProgress } from "@/components/ui/AnalysisProgress";
import { EmptyState } from "@/components/ui/EmptyState";
import { clearProgressStart, markRequestStart, markRequestEnd } from "@/lib/analysisState";
import { scholarSearchHrefFromPriorWork } from "@/lib/priorWorkLinks";
import { normalizeBibliographyCitationLine } from "@/lib/formatBibliography";

interface RelatedWorkPanelProps {
  paperId: string;
}

/** Shown beneath the Related tab chrome; explains bib-extracted citations + Scholar. */
const RELATED_TAB_INTRO =
  "Tap a citation to search Google Scholar. Reference lines come from this paper’s bibliography when we can extract them.";

/** One bibliography line: hyperlink wraps the verbatim excerpt; Scholar searches that text. */
function VerbatimCitationLink({ work }: { work: PriorWork }) {
  const scholarHref = scholarSearchHrefFromPriorWork(work);
  const raw =
    (typeof work.citation_display === "string" && work.citation_display.trim()) ||
    work.title.trim() ||
    "Reference";
  const display = normalizeBibliographyCitationLine(raw);

  const cls =
    "related-citation-display block text-[var(--text-sm)] leading-relaxed underline-offset-[3px] text-pretty hyphens-auto [overflow-wrap:anywhere]";

  return scholarHref ? (
    <a
      href={scholarHref}
      target="_blank"
      rel="noopener noreferrer"
      className={`${cls} font-medium text-primary underline decoration-primary/35 hover:decoration-primary`}
    >
      {display}
    </a>
  ) : (
    <span className={`${cls} font-medium text-foreground/95`}>{display}</span>
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

  if (preReadingLoading) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 py-8 motion-safe:animate-fade-in md:max-w-none">
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

  const topical =
    Array.isArray(preReading.prior_work_topics) &&
    preReading.prior_work_topics.some((t) => (t.items?.length ?? 0) > 0)
      ? preReading.prior_work_topics!.filter((t) => (t.items?.length ?? 0) > 0)
      : null;

  const showThemeHeading = (t: string) => {
    const s = (t || "").trim();
    if (!s) return false;
    if (/^other\s+references?$/i.test(s)) return false;
    return true;
  };

  return (
    <div className="space-y-6 motion-safe:animate-fade-in">
      <p className="text-[var(--text-xs)] leading-relaxed text-muted-foreground">{RELATED_TAB_INTRO}</p>
      {topical?.length ? (
        <div className="space-y-5">
          {topical.map((sec, si) => (
            <section
              key={`cluster-${si}`}
              className="rounded-xl border border-border/55 bg-card/35 px-4 py-3.5 shadow-sm shadow-black/[0.03] md:px-5 dark:bg-card/25 dark:shadow-black/25"
            >
              {showThemeHeading(sec.theme ?? "") ? (
                <p className="mb-2.5 border-b border-border/45 pb-2 text-[10px] font-semibold uppercase tracking-[0.13em] text-muted-foreground/90">
                  {sec.theme!.trim()}
                </p>
              ) : null}
              {(sec.summary || "").trim() ? (
                <div className="related-cluster-summary mb-4 [&_.analysis-content]:text-[var(--text-sm)] [&_.analysis-content]:leading-relaxed [&_.analysis-content_*]:text-foreground/92">
                  <Md>{sec.summary!}</Md>
                </div>
              ) : null}
              <ul className="flex flex-col gap-4">
                {(sec.items || []).map((p, pi) => (
                  <li key={`${p.bib_label ?? p.title}-${si}-${pi}`} className="flex gap-3.5 items-start">
                    <span
                      className="mt-0.5 flex h-6 min-w-[1.5rem] shrink-0 items-center justify-center rounded-md bg-muted/85 text-[10px] font-semibold tabular-nums leading-none text-muted-foreground shadow-[inset_0_1px_0_rgb(255_255_255/8%)]"
                      aria-hidden
                    >
                      {pi + 1}
                    </span>
                    <div className="min-w-0 flex-1 pt-px">
                      <VerbatimCitationLink work={p} />
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <ul className="flex flex-col gap-4">
          {priorList.map((p, i) => (
            <li key={`${p.bib_label ?? p.title}-${i}`} className="flex gap-3.5 items-start">
              <span
                className="mt-0.5 flex h-6 min-w-[1.5rem] shrink-0 items-center justify-center rounded-md bg-muted/85 text-[10px] font-semibold tabular-nums leading-none text-muted-foreground shadow-[inset_0_1px_0_rgb(255_255_255/8%)]"
                aria-hidden
              >
                {i + 1}
              </span>
              <div className="min-w-0 flex-1 pt-px">
                <VerbatimCitationLink work={p} />
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="border-t border-border/50 pt-3">
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
