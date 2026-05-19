"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { StreamingMarkdown } from "@/components/analysis/StreamingMarkdown";
import {
  autoAnalyzedPapers,
  clearProgressStart,
  hasActiveRequest,
  markRequestEnd,
  markRequestStart,
} from "@/lib/analysisState";
import { isPreReadingPopulated } from "@/lib/preReading";
import { useUserTier, canAccess } from "@/lib/UserTierContext";
import { AnalysisProgress } from "@/components/ui/AnalysisProgress";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionHeader } from "@/components/panel/SectionHeader";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

interface PreReadingPanelProps {
  paperId: string;
}

const rowListClass =
  "overflow-hidden rounded-xl border border-border/50 bg-card/25 shadow-[var(--shadow-xs)]";

const rowItemClass =
  "border-b border-border/45 px-4 py-3.5 last:border-b-0 motion-safe:transition-colors motion-safe:duration-150 hover:bg-accent/35";

export function PreReadingPanel({ paperId }: PreReadingPanelProps) {
  const preReading = useStore((s) => s.preReadingByPaper[paperId] ?? null);
  const setPreReadingForPaper = useStore((s) => s.setPreReadingForPaper);
  const updateCachedAnalysis = useStore((s) => s.updateCachedAnalysis);
  const preReadingLoading = useStore(
    (s) => s.preReadingLoadingByPaper[paperId] ?? false,
  );
  const setPreReadingLoadingForPaper = useStore(
    (s) => s.setPreReadingLoadingForPaper,
  );
  const setPreReadingError = useStore((s) => s.setPreReadingError);
  const autoError = useStore((s) => s.preReadingErrorByPaper[paperId] ?? null);
  const { user: tierUser } = useUserTier();
  const currentPaperRef = useRef(paperId);
  currentPaperRef.current = paperId;
  const [loadError, setLoadError] = useState<string | null>(null);
  const displayError = loadError ?? autoError;

  const handleAnalyze = async () => {
    const targetId = paperId;
    setLoadError(null);
    setPreReadingError(targetId, null);
    clearProgressStart(targetId, "preReading");
    markRequestStart(targetId, "preReading");
    setPreReadingLoadingForPaper(targetId, true);
    try {
      const result = await api.analyze(targetId);
      // Writes target `targetId`'s slot — safe even if the user has
      // already switched to a different paper.
      setPreReadingForPaper(targetId, result);
      updateCachedAnalysis(targetId, { pre_reading: result });
    } catch (e) {
      console.error("Analysis failed:", e);
      const msg = e instanceof Error ? e.message : "Prepare failed. Try again.";
      setLoadError(msg);
      setPreReadingError(targetId, msg);
    } finally {
      markRequestEnd(targetId, "preReading");
      clearProgressStart(targetId, "preReading");
      setPreReadingLoadingForPaper(targetId, false);
    }
  };

  useEffect(() => {
    const pid = paperId;
    if (
      !preReading &&
      !isPreReadingPopulated(preReading) &&
      !preReadingLoading &&
      !hasActiveRequest(pid, "preReading") &&
      !autoAnalyzedPapers.has(`${pid}:preReading`) &&
      canAccess(tierUser?.tier || "free", "prepare")
    ) {
      void handleAnalyze();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount safety net per paper
  }, [paperId]);

  if (preReadingLoading) {
    return (
      <div className="flex flex-col items-center gap-2 py-6 motion-safe:animate-fade-in">
        <div className="w-full max-w-[16rem]">
          <AnalysisProgress kind="preReading" paperId={paperId} />
        </div>
        <p className="text-[var(--text-xs)] text-muted-foreground/85">Analyzing paper…</p>
      </div>
    );
  }

  if (!preReading) {
    return (
      <EmptyState
        title="Prepare this paper"
        body={
          displayError ||
          "Extract definitions, research questions, and key concepts before you read."
        }
        cta={{ label: displayError ? "Retry Prepare" : "Analyze Paper", onClick: handleAnalyze }}
      />
    );
  }

  const definitions = preReading.definitions ?? [];
  const research_questions = preReading.research_questions ?? [];
  const concepts = preReading.concepts ?? [];

  const hasAnySection =
    definitions.length > 0 ||
    research_questions.length > 0 ||
    concepts.length > 0;

  if (!hasAnySection) {
    return (
      <EmptyState
        title="Prepare didn't extract structure"
        body={
          displayError ||
          "The analysis returned empty sections for this PDF. Retry, or confirm the PDF has a normal text layer."
        }
        cta={{ label: displayError ? "Retry Prepare" : "Analyze Paper again", onClick: handleAnalyze }}
      />
    );
  }

  return (
    <div className="space-y-1 motion-safe:animate-fade-in">
      <Accordion multiple defaultValue={[]}>
        {definitions.length > 0 && (
          <AccordionItem value="definitions" className="border-b-0">
            <AccordionTrigger className="py-2.5 hover:no-underline">
              <SectionHeader
                className="mb-0"
                title="Definitions"
                count={definitions.length}
              />
            </AccordionTrigger>
            <AccordionContent>
              <div className={rowListClass}>
                {definitions.map((d, i) => (
                  <div key={i} className={rowItemClass}>
                    <div className="mb-0.5 font-medium text-[var(--text-md)]">
                      <StreamingMarkdown size="tight">{d.term}</StreamingMarkdown>
                    </div>
                    <StreamingMarkdown>{d.definition}</StreamingMarkdown>
                    {d.source && (
                      <p className="mt-1 text-[var(--text-xs)] text-muted-foreground/70">Source: {d.source}</p>
                    )}
                  </div>
                ))}
              </div>
            </AccordionContent>
          </AccordionItem>
        )}

        {research_questions.length > 0 && (
          <AccordionItem value="questions" className="border-b-0">
            <AccordionTrigger className="py-2.5 hover:no-underline">
              <SectionHeader
                className="mb-0"
                title="Research questions"
                count={research_questions.length}
              />
            </AccordionTrigger>
            <AccordionContent>
              <div className={rowListClass}>
                {research_questions.map((q, i) => (
                  <div key={i} className={rowItemClass}>
                    <StreamingMarkdown>{q.question}</StreamingMarkdown>
                    {q.context && (
                      <div className="mt-1 text-[var(--text-xs)] text-muted-foreground/80">
                        <StreamingMarkdown>{q.context}</StreamingMarkdown>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </AccordionContent>
          </AccordionItem>
        )}

        {concepts.length > 0 && (
          <AccordionItem value="concepts" className="border-b-0">
            <AccordionTrigger className="py-2.5 hover:no-underline">
              <SectionHeader
                className="mb-0"
                title="Key concepts"
                count={concepts.length}
              />
            </AccordionTrigger>
            <AccordionContent>
              <div className={rowListClass}>
                {concepts.map((c, i) => (
                  <div key={i} className={rowItemClass}>
                    <div className="mb-0.5 font-medium text-[var(--text-md)]">
                      <StreamingMarkdown size="tight">{c.name}</StreamingMarkdown>
                    </div>
                    <StreamingMarkdown>{c.description}</StreamingMarkdown>
                    {c.importance && (
                      <div className="mt-1 text-[var(--text-xs)] italic text-muted-foreground/70">
                        <StreamingMarkdown>{c.importance}</StreamingMarkdown>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </AccordionContent>
          </AccordionItem>
        )}
      </Accordion>

      <div className="pt-2">
        <button
          type="button"
          onClick={handleAnalyze}
          className="text-[var(--text-xs)] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          Re-analyze
        </button>
      </div>
    </div>
  );
}
