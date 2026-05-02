"use client";

import { useCallback, useRef, useState } from "react";
import { api, type PriorWork } from "@/lib/api";
import { useStore } from "@/lib/store";
import { Md } from "@/components/ui/Md";
import { AnalysisProgress } from "@/components/ui/AnalysisProgress";
import { EmptyState } from "@/components/ui/EmptyState";
import { clearProgressStart, markRequestStart, markRequestEnd } from "@/lib/analysisState";
import { scholarSearchHrefFromPriorWork } from "@/lib/priorWorkLinks";

interface RelatedWorkPanelProps {
  paperId: string;
}

/** Shown beneath the Related tab chrome; explains bib-extracted citations + Scholar. */
const RELATED_TAB_INTRO =
  "Click a citation link to search Google Scholar for that related work. Lines come from this paper’s bibliography where we could extract them.";

/** One bibliography line: hyperlink wraps the verbatim excerpt; Scholar searches that text. */
function VerbatimCitationLink({ work }: { work: PriorWork }) {
  const scholarHref = scholarSearchHrefFromPriorWork(work);
  const display =
    (typeof work.citation_display === "string" && work.citation_display.trim()) ||
    work.title.trim() ||
    "Reference";

  const cls =
    "whitespace-pre-wrap text-[var(--text-md)] font-medium leading-relaxed underline-offset-2";

  return scholarHref ? (
    <a
      href={scholarHref}
      target="_blank"
      rel="noopener noreferrer"
      className={`${cls} text-primary underline hover:opacity-90`}
    >
      {display}
    </a>
  ) : (
    <span className={`${cls} text-foreground/95`}>{display}</span>
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

  return (
    <div className="space-y-8 motion-safe:animate-fade-in">
      <p className="text-[var(--text-xs)] leading-relaxed text-muted-foreground">{RELATED_TAB_INTRO}</p>
      {topical?.length ? (
        topical.map((sec, si) => (
          <section key={`cluster-${si}`} className="space-y-3">
            {(sec.summary || "").trim() ? (
              <div className="text-[var(--text-sm)] leading-relaxed text-foreground">
                <Md>{sec.summary}</Md>
              </div>
            ) : null}
            <ul className="list-disc space-y-2.5 pl-5 marker:text-muted-foreground/70">
              {(sec.items || []).map((p, pi) => (
                <li key={`${p.bib_label ?? p.title}-${si}-${pi}`} className="pl-1">
                  <VerbatimCitationLink work={p} />
                </li>
              ))}
            </ul>
          </section>
        ))
      ) : (
        <ul className="list-disc space-y-2.5 pl-5 marker:text-muted-foreground/70">
          {priorList.map((p, i) => (
            <li key={`${p.bib_label ?? p.title}-${i}`} className="pl-1">
              <VerbatimCitationLink work={p} />
            </li>
          ))}
        </ul>
      )}

      <div className="border-t border-border/50 pt-1">
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
