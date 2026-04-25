"use client";

import { useRef } from "react";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { Md } from "@/components/ui/Md";
import { clearProgressStart, markRequestStart, markRequestEnd } from "@/lib/analysisState";
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
  "overflow-hidden rounded-lg border border-border/60 bg-card/30";

const rowItemClass =
  "border-b border-border/60 px-4 py-3 last:border-b-0 motion-safe:transition-colors motion-safe:duration-150 motion-safe:ease-out hover:bg-accent/40";

export function PreReadingPanel({ paperId }: PreReadingPanelProps) {
  const { preReading, setPreReading, preReadingLoading, setPreReadingLoading } = useStore();
  const currentPaperRef = useRef(paperId);
  currentPaperRef.current = paperId;

  const handleAnalyze = async () => {
    const targetId = paperId;
    clearProgressStart(targetId, "preReading");
    markRequestStart(targetId, "preReading");
    setPreReadingLoading(true);
    try {
      const result = await api.analyze(targetId);
      if (currentPaperRef.current === targetId) {
        setPreReading(result);
      }
    } catch (e) {
      console.error("Analysis failed:", e);
    } finally {
      markRequestEnd(targetId, "preReading");
      clearProgressStart(targetId, "preReading");
      if (currentPaperRef.current === targetId) {
        setPreReadingLoading(false);
      }
    }
  };

  if (preReadingLoading) {
    return (
      <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 py-8 motion-safe:animate-fade-in">
        <div className="w-full max-w-xs">
          <AnalysisProgress kind="preReading" paperId={paperId} />
        </div>
        <p className="text-[var(--text-sm)] text-muted-foreground">Analyzing paper…</p>
      </div>
    );
  }

  if (!preReading) {
    return (
      <EmptyState
        title="Prepare this paper"
        body="Extract definitions, research questions, prior work, and concepts before reading."
        cta={{ label: "Analyze Paper", onClick: handleAnalyze }}
      />
    );
  }

  const { definitions, research_questions, prior_work, concepts } = preReading;

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
                    <p className="mb-0.5 font-medium text-[var(--text-md)]">{d.term}</p>
                    <div className="text-[var(--text-sm)] text-muted-foreground">
                      <Md>{d.definition}</Md>
                    </div>
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
                    <div className="text-[var(--text-md)]">
                      <Md>{q.question}</Md>
                    </div>
                    {q.context && (
                      <div className="mt-1 text-[var(--text-xs)] text-muted-foreground/80">
                        <Md>{q.context}</Md>
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
                    <p className="mb-0.5 font-medium text-[var(--text-md)]">{c.name}</p>
                    <div className="text-[var(--text-sm)] text-muted-foreground">
                      <Md>{c.description}</Md>
                    </div>
                    {c.importance && (
                      <div className="mt-1 text-[var(--text-xs)] italic text-muted-foreground/70">
                        <Md>{c.importance}</Md>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </AccordionContent>
          </AccordionItem>
        )}

        {prior_work.length > 0 && (
          <AccordionItem value="prior" className="border-b-0">
            <AccordionTrigger className="py-2.5 hover:no-underline">
              <SectionHeader
                className="mb-0"
                title="Prior work"
                count={prior_work.length}
              />
            </AccordionTrigger>
            <AccordionContent>
              <div className={rowListClass}>
                {prior_work.map((p, i) => (
                  <div key={i} className={rowItemClass}>
                    <p className="mb-0.5 font-medium text-[var(--text-md)]">{p.title}</p>
                    <div className="text-[var(--text-sm)] text-muted-foreground">
                      <Md>{p.relevance}</Md>
                    </div>
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
