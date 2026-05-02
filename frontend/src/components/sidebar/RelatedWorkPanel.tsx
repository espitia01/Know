"use client";

import { useRef } from "react";
import { api, type PriorWork } from "@/lib/api";
import { useStore } from "@/lib/store";
import { Md } from "@/components/ui/Md";
import { AnalysisProgress } from "@/components/ui/AnalysisProgress";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionHeader } from "@/components/panel/SectionHeader";
import { clearProgressStart, markRequestStart, markRequestEnd } from "@/lib/analysisState";
import { priorWorkHref, scholarSearchHref } from "@/lib/priorWorkLinks";

interface RelatedWorkPanelProps {
  paperId: string;
}

function WorkBullet({ p }: { p: PriorWork }) {
  const canonical = priorWorkHref(p);
  const scholarHref = scholarSearchHref(p.title);
  const href = canonical ?? scholarHref ?? null;
  const titleDisplay = p.title.trim() || "Untitled reference";
  const bib = (p.bib_label || p.ref_id || "").trim();

  return (
    <li className="pl-1">
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          {bib && (
            <span className="shrink-0 rounded bg-muted/80 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              [{bib.replace(/^\[|\]$/g, "")}]
            </span>
          )}
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className={
                canonical
                  ? "text-[var(--text-md)] font-medium text-primary underline underline-offset-2 hover:opacity-90"
                  : "text-[var(--text-md)] font-medium text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
              }
            >
              {titleDisplay}
            </a>
          ) : (
            <span className="text-[var(--text-md)] font-medium text-foreground/90">{titleDisplay}</span>
          )}
        </div>
        {!canonical && scholarHref ? (
          <p className="text-[var(--text-xs)] text-muted-foreground/70">
            No publisher link from the bibliography — opens Google Scholar with this title.
          </p>
        ) : null}
        {(p.doi || p.arxiv) && (
          <p className="text-[10px] font-mono leading-relaxed text-muted-foreground/65">
            {p.doi && <span>{p.doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")}</span>}
            {p.doi && p.arxiv ? " · " : null}
            {p.arxiv && <span>arXiv:{p.arxiv}</span>}
          </p>
        )}
        {p.relevance && (
          <div className="text-[var(--text-sm)] leading-relaxed text-muted-foreground">
            <Md>{p.relevance}</Md>
          </div>
        )}
      </div>
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
            ? "Prepare did not capture related references for this PDF. Try re-running Prepare—the bibliography prints best when the PDF text layer is clean."
            : "Run Prepare once — we map each theme to bibliography entries and resolve outbound links."
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
        Entries are clustered by thematic role in this paper whenever the model identifies clear groupings.
        Each title links to a DOI, arXiv, publisher, or Semantic Scholar match when possible; otherwise to a Scholar search for that title.
      </p>

      {topical?.length ? (
        <div className="space-y-8">
          {topical.map((sec, si) => (
            <section key={`${sec.theme}-${si}`} className="space-y-3">
              <SectionHeader title={sec.theme || "Related work"} className="mb-0 text-[var(--text-sm)]" />
              {sec.summary ? (
                <div className="text-[var(--text-sm)] leading-relaxed text-muted-foreground">
                  <Md>{sec.summary}</Md>
                </div>
              ) : null}
              <ul className="list-disc space-y-4 pl-4 marker:text-muted-foreground/60">
                {(sec.items || []).map((p, pi) => (
                  <WorkBullet key={`${p.title}-${si}-${pi}`} p={p} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : (
        <ul className="list-disc space-y-4 pl-4 marker:text-muted-foreground/60">
          {preReading.prior_work.map((p, i) => (
            <WorkBullet key={`${p.title}-${i}`} p={p} />
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
