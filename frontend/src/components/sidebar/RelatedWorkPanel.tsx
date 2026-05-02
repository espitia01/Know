"use client";

import { useRef } from "react";
import { api, type PriorWork } from "@/lib/api";
import { useStore } from "@/lib/store";
import { Md } from "@/components/ui/Md";
import { AnalysisProgress } from "@/components/ui/AnalysisProgress";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionHeader } from "@/components/panel/SectionHeader";
import { clearProgressStart, markRequestStart, markRequestEnd } from "@/lib/analysisState";
import { scholarSearchHrefFromPriorWork } from "@/lib/priorWorkLinks";

interface RelatedWorkPanelProps {
  paperId: string;
}

function citationAlreadyOpensWithBibKey(bibRaw: string, citation: string): boolean {
  const n = bibRaw.replace(/\[|\]/g, "").trim();
  if (!n) return false;
  const t = citation.trimStart().slice(0, 140);
  if (t.startsWith(`[${n}]`) || new RegExp(`^\\s*${n}\\.\\s`).test(t)) return true;
  if (new RegExp(`^\\s*\\(${n}\\)\\s`).test(t)) return true;
  return false;
}

function ReferenceRow({ p }: { p: PriorWork }) {
  const scholarHref = scholarSearchHrefFromPriorWork(p);
  const bib = (p.bib_label || p.ref_id || "").trim();
  const display =
    (typeof p.citation_display === "string" && p.citation_display.trim()) ||
    p.title.trim() ||
    "Reference";
  const showBibChip = Boolean(bib) && !citationAlreadyOpensWithBibKey(bib, display);

  return (
    <li className="border-b border-border/45 py-3 pl-1 last:border-b-0">
      <div className="flex flex-col gap-2">
        {showBibChip && (
          <span className="w-fit shrink-0 rounded bg-muted/80 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            [{bib.replace(/^\[|\]$/g, "")}]
          </span>
        )}
        <div className="min-w-0">
          {scholarHref ? (
            <a
              href={scholarHref}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--text-md)] font-medium leading-snug text-primary underline underline-offset-2 hover:opacity-90 whitespace-pre-wrap"
            >
              {display}
            </a>
          ) : (
            <span className="text-[var(--text-md)] font-medium leading-snug text-foreground/95 whitespace-pre-wrap">
              {display}
            </span>
          )}
        </div>
      </div>
      {(p.doi || p.arxiv) ? (
        <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-muted-foreground/60">
          {p.doi && <span>{p.doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")}</span>}
          {p.doi && p.arxiv ? " · " : null}
          {p.arxiv && <span>arXiv:{p.arxiv}</span>}
        </p>
      ) : null}
      {p.relevance ? (
        <div className="mt-2 text-[var(--text-sm)] leading-relaxed text-muted-foreground">
          <Md>{p.relevance}</Md>
        </div>
      ) : null}
    </li>
  );
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
        <p className="text-[var(--text-sm)] text-muted-foreground">Parsing references…</p>
      </div>
    );
  }

  if (!preReading || preReading.prior_work.length === 0) {
    return (
      <EmptyState
        title={preReading ? "No references parsed" : "References not generated"}
        body={
          preReading
            ? "The PDF did not yield a clean numbered bibliography. Re-run Prepare when the references block is selectable text."
            : "Run Prepare to list references as in the paper; each opens a Google Scholar search for that citation text."
        }
        cta={{ label: "Run Prepare", onClick: handleRunPrepare }}
      />
    );
  }

  const topical =
    Array.isArray(preReading.prior_work_topics) &&
    preReading.prior_work_topics.some((t) => (t.items?.length ?? 0) > 0)
      ? preReading.prior_work_topics!.filter((t) => (t.items?.length ?? 0) > 0)
      : null;

  return (
    <div className="space-y-6 motion-safe:animate-fade-in">
      <p className="text-[var(--text-xs)] leading-relaxed text-muted-foreground/85">
        Each entry shows the bibliography line from the PDF. Click it to search that exact citation text on Google Scholar. Notes below summarise how this paper uses the source—not a substitute for the citation line.
      </p>

      {topical?.length ? (
        <div className="space-y-8">
          {topical.map((sec, si) => (
            <section key={`${sec.theme}-${si}`} className="space-y-2">
              <SectionHeader title={sec.theme || "References"} className="mb-0 text-[var(--text-sm)]" />
              {sec.summary ? (
                <div className="text-[var(--text-sm)] leading-relaxed text-muted-foreground">
                  <Md>{sec.summary}</Md>
                </div>
              ) : null}
              <ol className="list-none space-y-0 pl-0 marker:text-muted-foreground/60">
                {(sec.items || []).map((p, pi) => (
                  <ReferenceRow key={`${p.bib_label ?? p.title}-${si}-${pi}`} p={p} />
                ))}
              </ol>
            </section>
          ))}
        </div>
      ) : (
        <ol className="list-none space-y-0 pl-0">
          {preReading.prior_work.map((p, i) => (
            <ReferenceRow key={`${p.bib_label ?? p.title}-${i}`} p={p} />
          ))}
        </ol>
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
