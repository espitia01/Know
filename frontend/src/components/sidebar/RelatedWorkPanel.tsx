"use client";

import { useRef } from "react";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { Md } from "@/components/ui/Md";
import { AnalysisProgress } from "@/components/ui/AnalysisProgress";
import { EmptyState } from "@/components/ui/EmptyState";
import { clearProgressStart, markRequestStart, markRequestEnd } from "@/lib/analysisState";
import { priorWorkHref } from "@/lib/priorWorkLinks";

interface RelatedWorkPanelProps {
  paperId: string;
}

export function RelatedWorkPanel({ paperId }: RelatedWorkPanelProps) {
  const { preReading, setPreReading, preReadingLoading, setPreReadingLoading } = useStore();
  const currentPaperRef = useRef(paperId);
  currentPaperRef.current = paperId;

  const handleRunPrepare = async () => {
    const targetId = paperId;
    clearProgressStart(targetId, "preReading");
    markRequestStart(targetId, "preReading");
    setPreReadingLoading(true);
    try {
      const result = await api.analyze(targetId);
      if (currentPaperRef.current === targetId) setPreReading(result);
    } catch (e) {
      console.error("Prepare analysis failed:", e);
    } finally {
      markRequestEnd(targetId, "preReading");
      clearProgressStart(targetId, "preReading");
      if (currentPaperRef.current === targetId) setPreReadingLoading(false);
    }
  };

  if (preReadingLoading) {
    return (
      <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 py-8 motion-safe:animate-fade-in">
        <div className="w-full max-w-xs">
          <AnalysisProgress kind="preReading" paperId={paperId} />
        </div>
        <p className="text-[var(--text-sm)] text-muted-foreground">Extracting references…</p>
      </div>
    );
  }

  if (!preReading || preReading.prior_work.length === 0) {
    return (
      <EmptyState
        title={preReading ? "No linked sources yet" : "Related work not generated"}
        body={
          preReading
            ? "Prepare did not capture prior-work rows for this PDF. Try re-running Prepare if the bibliography is visible in the extracted text."
            : "Run Prepare once — we derive related papers from how this article cites earlier work."
        }
        cta={{ label: "Run Prepare", onClick: handleRunPrepare }}
      />
    );
  }

  const rows = preReading.prior_work;

  return (
    <div className="space-y-4 motion-safe:animate-fade-in">
      <p className="text-[var(--text-xs)] leading-relaxed text-muted-foreground/85">
        Links open when Prepare supplies a URL or when we derive arXiv / DOI / PubMed IDs from{' '}
        <span className="font-mono text-[10px]">ref_id</span>.
      </p>
      <ul className="list-disc space-y-4 pl-4 marker:text-muted-foreground/60">
        {rows.map((p, i) => {
          const href = priorWorkHref(p);
          const titleDisplay = p.title.trim() || "Untitled reference";
          return (
            <li key={`${p.title}-${i}`} className="pl-1">
              <div className="space-y-1">
                {href ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[var(--text-md)] font-medium text-primary underline underline-offset-2 hover:opacity-90"
                  >
                    {titleDisplay}
                  </a>
                ) : (
                  <span className="text-[var(--text-md)] font-medium text-foreground/90">{titleDisplay}</span>
                )}
                {p.relevance && (
                  <div className="text-[var(--text-sm)] leading-relaxed text-muted-foreground">
                    <Md>{p.relevance}</Md>
                  </div>
                )}
                {!href && p.ref_id ? (
                  <p className="text-[var(--text-xs)] text-muted-foreground/75">
                    Reference id: <span className="font-mono">{p.ref_id}</span>
                    {' — '}no inferred link yet
                  </p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
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
