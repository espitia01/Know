"use client";

import { useRef } from "react";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { Md } from "@/components/ui/Md";
import { clearProgressStart, markRequestStart, markRequestEnd } from "@/lib/analysisState";
import { AnalysisProgress } from "@/components/ui/AnalysisProgress";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

interface PreReadingPanelProps {
  paperId: string;
}

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
      <div className="flex flex-col items-center gap-3 py-8 justify-center animate-fade-in">
        <AnalysisProgress kind="preReading" paperId={paperId} />
        <p className="text-[var(--text-md)] text-muted-foreground">Analyzing paper...</p>
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
    <div className="space-y-1 animate-fade-in">
      <Accordion multiple defaultValue={[]}>
        {definitions.length > 0 && (
          <AccordionItem value="definitions" className="border-b-0">
            <AccordionTrigger className="text-[var(--text-md)] font-semibold py-2.5 hover:no-underline">
              <span>Definitions <span className="text-muted-foreground/50 font-normal ml-1">{definitions.length}</span></span>
            </AccordionTrigger>
            <AccordionContent>
              <div className="space-y-2 pb-2">
                {definitions.map((d, i) => (
                  <div key={i} className="rounded-xl glass-subtle px-3.5 py-2.5">
                    <p className="font-medium text-[var(--text-md)] mb-0.5">{d.term}</p>
                    <div className="text-[var(--text-sm)] text-muted-foreground"><Md>{d.definition}</Md></div>
                    {d.source && <p className="text-[var(--text-xs)] text-muted-foreground/50 mt-1">Source: {d.source}</p>}
                  </div>
                ))}
              </div>
            </AccordionContent>
          </AccordionItem>
        )}

        {research_questions.length > 0 && (
          <AccordionItem value="questions" className="border-b-0">
            <AccordionTrigger className="text-[var(--text-md)] font-semibold py-2.5 hover:no-underline">
              <span>Research Questions <span className="text-muted-foreground/50 font-normal ml-1">{research_questions.length}</span></span>
            </AccordionTrigger>
            <AccordionContent>
              <div className="space-y-2 pb-2">
                {research_questions.map((q, i) => (
                  <div key={i} className="rounded-xl glass-subtle px-3.5 py-2.5">
                    <div className="text-[var(--text-md)]"><Md>{q.question}</Md></div>
                    {q.context && <div className="text-[var(--text-xs)] text-muted-foreground/70 mt-1"><Md>{q.context}</Md></div>}
                  </div>
                ))}
              </div>
            </AccordionContent>
          </AccordionItem>
        )}

        {concepts.length > 0 && (
          <AccordionItem value="concepts" className="border-b-0">
            <AccordionTrigger className="text-[var(--text-md)] font-semibold py-2.5 hover:no-underline">
              <span>Key Concepts <span className="text-muted-foreground/50 font-normal ml-1">{concepts.length}</span></span>
            </AccordionTrigger>
            <AccordionContent>
              <div className="space-y-2 pb-2">
                {concepts.map((c, i) => (
                  <div key={i} className="rounded-xl glass-subtle px-3.5 py-2.5">
                    <p className="font-medium text-[var(--text-md)] mb-0.5">{c.name}</p>
                    <div className="text-[var(--text-sm)] text-muted-foreground"><Md>{c.description}</Md></div>
                    {c.importance && <div className="text-[var(--text-xs)] text-muted-foreground/50 mt-1 italic"><Md>{c.importance}</Md></div>}
                  </div>
                ))}
              </div>
            </AccordionContent>
          </AccordionItem>
        )}

        {prior_work.length > 0 && (
          <AccordionItem value="prior" className="border-b-0">
            <AccordionTrigger className="text-[var(--text-md)] font-semibold py-2.5 hover:no-underline">
              <span>Prior Work <span className="text-muted-foreground/50 font-normal ml-1">{prior_work.length}</span></span>
            </AccordionTrigger>
            <AccordionContent>
              <div className="space-y-2 pb-2">
                {prior_work.map((p, i) => (
                  <div key={i} className="rounded-xl glass-subtle px-3.5 py-2.5">
                    <p className="font-medium text-[var(--text-md)] mb-0.5">{p.title}</p>
                    <div className="text-[var(--text-sm)] text-muted-foreground"><Md>{p.relevance}</Md></div>
                  </div>
                ))}
              </div>
            </AccordionContent>
          </AccordionItem>
        )}
      </Accordion>

      <div className="pt-2">
        <button
          onClick={handleAnalyze}
          className="text-[var(--text-sm)] text-muted-foreground/60 hover:text-muted-foreground transition-colors font-medium"
        >
          Re-analyze
        </button>
      </div>
    </div>
  );
}
