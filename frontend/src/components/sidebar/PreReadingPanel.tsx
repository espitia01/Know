"use client";

import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { Button } from "@/components/ui/button";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

interface PreReadingPanelProps {
  paperId: string;
}

function Md({ children }: { children: string }) {
  return (
    <div className="analysis-content">
      <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

export function PreReadingPanel({ paperId }: PreReadingPanelProps) {
  const { preReading, setPreReading, preReadingLoading, setPreReadingLoading } = useStore();

  const handleAnalyze = async () => {
    setPreReadingLoading(true);
    try {
      const result = await api.analyze(paperId);
      setPreReading(result);
    } catch (e) {
      console.error("Analysis failed:", e);
    } finally {
      setPreReadingLoading(false);
    }
  };

  if (preReadingLoading) {
    return (
      <div className="flex items-center gap-3 py-8 justify-center animate-fade-in">
        <div className="w-4 h-4 border-2 border-muted-foreground/30 border-t-foreground rounded-full animate-spin" />
        <p className="text-[13px] text-muted-foreground">Analyzing paper...</p>
      </div>
    );
  }

  if (!preReading) {
    return (
      <div className="py-8 text-center space-y-3 animate-fade-in">
        <p className="text-[14px] text-muted-foreground">
          Extract definitions, research questions, prior work, and concepts.
        </p>
        <Button onClick={handleAnalyze} size="sm" className="text-[13px] h-8 px-5">
          Analyze Paper
        </Button>
      </div>
    );
  }

  const { definitions, research_questions, prior_work, concepts } = preReading;

  return (
    <div className="space-y-1 animate-fade-in">
      <Accordion multiple defaultValue={["definitions", "questions", "concepts", "prior"]}>
        {definitions.length > 0 && (
          <AccordionItem value="definitions" className="border-b-0">
            <AccordionTrigger className="text-[13px] font-semibold py-2.5 hover:no-underline">
              <span>Definitions <span className="text-muted-foreground/50 font-normal ml-1">{definitions.length}</span></span>
            </AccordionTrigger>
            <AccordionContent>
              <div className="space-y-1.5 pb-2">
                {definitions.map((d, i) => (
                  <div key={i} className="rounded-lg bg-accent/50 px-3.5 py-2.5">
                    <p className="font-medium text-[13px] mb-0.5">{d.term}</p>
                    <div className="text-[12px] text-muted-foreground"><Md>{d.definition}</Md></div>
                    {d.source && <p className="text-[11px] text-muted-foreground/50 mt-1">Source: {d.source}</p>}
                  </div>
                ))}
              </div>
            </AccordionContent>
          </AccordionItem>
        )}

        {research_questions.length > 0 && (
          <AccordionItem value="questions" className="border-b-0">
            <AccordionTrigger className="text-[13px] font-semibold py-2.5 hover:no-underline">
              <span>Research Questions <span className="text-muted-foreground/50 font-normal ml-1">{research_questions.length}</span></span>
            </AccordionTrigger>
            <AccordionContent>
              <div className="space-y-1.5 pb-2">
                {research_questions.map((q, i) => (
                  <div key={i} className="rounded-lg bg-accent/50 px-3.5 py-2.5">
                    <div className="text-[13px]"><Md>{q.question}</Md></div>
                    {q.context && <p className="text-[11px] text-muted-foreground/70 mt-1">{q.context}</p>}
                  </div>
                ))}
              </div>
            </AccordionContent>
          </AccordionItem>
        )}

        {concepts.length > 0 && (
          <AccordionItem value="concepts" className="border-b-0">
            <AccordionTrigger className="text-[13px] font-semibold py-2.5 hover:no-underline">
              <span>Key Concepts <span className="text-muted-foreground/50 font-normal ml-1">{concepts.length}</span></span>
            </AccordionTrigger>
            <AccordionContent>
              <div className="space-y-1.5 pb-2">
                {concepts.map((c, i) => (
                  <div key={i} className="rounded-lg bg-accent/50 px-3.5 py-2.5">
                    <p className="font-medium text-[13px] mb-0.5">{c.name}</p>
                    <div className="text-[12px] text-muted-foreground"><Md>{c.description}</Md></div>
                    {c.importance && <p className="text-[11px] text-muted-foreground/50 mt-1 italic">{c.importance}</p>}
                  </div>
                ))}
              </div>
            </AccordionContent>
          </AccordionItem>
        )}

        {prior_work.length > 0 && (
          <AccordionItem value="prior" className="border-b-0">
            <AccordionTrigger className="text-[13px] font-semibold py-2.5 hover:no-underline">
              <span>Prior Work <span className="text-muted-foreground/50 font-normal ml-1">{prior_work.length}</span></span>
            </AccordionTrigger>
            <AccordionContent>
              <div className="space-y-1.5 pb-2">
                {prior_work.map((p, i) => (
                  <div key={i} className="rounded-lg bg-accent/50 px-3.5 py-2.5">
                    <p className="font-medium text-[13px] mb-0.5">{p.title}</p>
                    <p className="text-[12px] text-muted-foreground">{p.relevance}</p>
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
          className="text-[12px] text-muted-foreground/60 hover:text-muted-foreground transition-colors font-medium"
        >
          Re-analyze
        </button>
      </div>
    </div>
  );
}
