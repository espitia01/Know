"use client";

import { useState, useMemo } from "react";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { Textarea } from "@/components/ui/textarea";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

interface DerivationPanelProps {
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

function extractSectionHeadings(markdown: string): string[] {
  const headings: string[] = [];
  for (const line of markdown.split("\n")) {
    const match = line.match(/^##\s+(.+)/);
    if (match) headings.push(match[1].trim());
  }
  return headings;
}

export function DerivationPanel({ paperId }: DerivationPanelProps) {
  const { paper, exercise, setExercise, exerciseLoading, setExerciseLoading } = useStore();
  const [userAnswers, setUserAnswers] = useState<Record<number, string>>({});
  const [revealedSteps, setRevealedSteps] = useState<Set<number>>(new Set());
  const [showHints, setShowHints] = useState<Set<number>>(new Set());

  const sectionHeadings = useMemo(() => {
    if (!paper?.content_markdown) return [];
    return extractSectionHeadings(paper.content_markdown);
  }, [paper?.content_markdown]);

  const handleGenerate = async (sectionHeading: string) => {
    setExerciseLoading(true);
    setRevealedSteps(new Set());
    setShowHints(new Set());
    setUserAnswers({});
    try {
      const result = await api.getDerivationExercise(paperId, sectionHeading);
      setExercise(result);
    } catch (e) {
      console.error("Derivation exercise generation failed:", e);
    } finally {
      setExerciseLoading(false);
    }
  };

  const toggleHint = (stepNum: number) => {
    setShowHints((prev) => {
      const next = new Set(prev);
      if (next.has(stepNum)) next.delete(stepNum); else next.add(stepNum);
      return next;
    });
  };

  const revealStep = (stepNum: number) => {
    setRevealedSteps((prev) => new Set(prev).add(stepNum));
  };

  const revealAll = () => {
    if (exercise) setRevealedSteps(new Set(exercise.steps.map((s) => s.step_number)));
  };

  if (exerciseLoading) {
    return (
      <div className="flex items-center gap-3 py-8 justify-center animate-fade-in">
        <div className="w-4 h-4 border-2 border-muted-foreground/30 border-t-foreground rounded-full animate-spin" />
        <p className="text-[13px] text-muted-foreground">Generating derivation exercise...</p>
      </div>
    );
  }

  if (!exercise) {
    return (
      <div className="space-y-4 animate-fade-in">
        <div className="py-3">
          <p className="text-[14px] text-muted-foreground">
            Select a section to practice deriving key results step by step.
          </p>
          <p className="text-[12px] text-muted-foreground/50 mt-1">
            You&apos;ll get a prompt for each step. Try to work it out, then check your answer.
          </p>
        </div>

        {sectionHeadings.length > 0 && (
          <div className="grid grid-cols-2 gap-1.5">
            {sectionHeadings.map((heading, i) => (
              <button
                key={i}
                onClick={() => handleGenerate(heading)}
                className="text-left text-[12px] font-medium px-3 py-2 rounded-lg bg-accent/50 hover:bg-accent text-foreground/80 hover:text-foreground transition-colors truncate"
              >
                {heading}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  const totalSteps = exercise.steps.length;
  const revealed = revealedSteps.size;

  return (
    <div className="space-y-3 animate-fade-in">
      {/* Header */}
      <div className="pb-2 border-b space-y-1">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[14px] font-semibold truncate flex-1">{exercise.title}</p>
          <div className="flex gap-2 shrink-0">
            <button onClick={revealAll} className="text-[12px] text-muted-foreground hover:text-foreground transition-colors font-medium">
              Reveal All
            </button>
            <button onClick={() => { setExercise(null); setUserAnswers({}); }} className="text-[12px] text-muted-foreground/50 hover:text-muted-foreground transition-colors">
              Back
            </button>
          </div>
        </div>

        {exercise.starting_point && (
          <div className="text-[12px] text-muted-foreground">
            <span className="font-medium text-foreground/60">Start from: </span>
            <Md>{exercise.starting_point}</Md>
          </div>
        )}
        {exercise.final_result && (
          <div className="text-[12px] text-muted-foreground">
            <span className="font-medium text-foreground/60">Goal: </span>
            <Md>{exercise.final_result}</Md>
          </div>
        )}

        <p className="text-[11px] text-muted-foreground/50">{revealed}/{totalSteps} steps completed</p>
      </div>

      {/* Steps */}
      <div className="space-y-3">
        {exercise.steps.map((step, idx) => {
          const isRevealed = revealedSteps.has(step.step_number);
          const hintVisible = showHints.has(step.step_number);
          const isNext = !isRevealed && (idx === 0 || revealedSteps.has(exercise.steps[idx - 1]?.step_number));
          const promptText = step.prompt || step.explanation || "Complete this step";
          const answerText = step.answer || step.expression || "";

          return (
            <div
              key={step.step_number}
              className={`rounded-lg transition-all duration-200 ${
                isRevealed
                  ? "bg-accent/40 px-3.5 py-3"
                  : isNext
                  ? "bg-accent/70 ring-1 ring-foreground/10 px-3.5 py-3"
                  : "bg-accent/20 opacity-40 px-3.5 py-2"
              }`}
            >
              {/* Step header */}
              <div className="flex items-start justify-between gap-2 mb-1.5">
                <span className={`text-[11px] font-semibold uppercase tracking-wider shrink-0 ${
                  isRevealed ? "text-foreground/40" : isNext ? "text-foreground/70" : "text-muted-foreground/30"
                }`}>
                  Step {step.step_number}
                </span>
                <div className="flex gap-2">
                  {step.hint && !hintVisible && !isRevealed && isNext && (
                    <button onClick={() => toggleHint(step.step_number)} className="text-[11px] text-muted-foreground hover:text-foreground transition-colors font-medium">
                      Hint
                    </button>
                  )}
                  {!isRevealed && isNext && (
                    <button onClick={() => revealStep(step.step_number)} className="text-[11px] text-foreground/60 hover:text-foreground transition-colors font-medium">
                      Check Answer
                    </button>
                  )}
                </div>
              </div>

              {/* Prompt (always visible for current/revealed) */}
              {(isNext || isRevealed) && (
                <div className="text-[13px] font-medium mb-2">
                  <Md>{promptText}</Md>
                </div>
              )}

              {/* Hint */}
              {hintVisible && step.hint && !isRevealed && (
                <div className="text-[12px] text-muted-foreground italic bg-background/50 rounded-md px-2.5 py-1.5 mb-2">
                  <Md>{step.hint}</Md>
                </div>
              )}

              {/* User's workspace (input area for the next step) */}
              {isNext && !isRevealed && (
                <div className="mb-2">
                  <Textarea
                    placeholder="Write your answer here (optional)..."
                    value={userAnswers[step.step_number] || ""}
                    onChange={(e) => setUserAnswers((prev) => ({ ...prev, [step.step_number]: e.target.value }))}
                    rows={2}
                    className="text-[12px] resize-none bg-background/60"
                  />
                </div>
              )}

              {/* Revealed answer */}
              {isRevealed && answerText && (
                <div className="space-y-1.5 pt-1 border-t border-border/30">
                  <div className="text-[13px]">
                    <span className="text-[10px] uppercase tracking-wider text-foreground/40 font-semibold">Answer: </span>
                    <Md>{answerText}</Md>
                  </div>
                  {step.explanation && step.prompt && (
                    <div className="text-[12px] text-muted-foreground">
                      <Md>{step.explanation}</Md>
                    </div>
                  )}
                  {userAnswers[step.step_number] && (
                    <div className="text-[11px] text-muted-foreground/50 bg-background/40 rounded px-2 py-1">
                      <span className="font-medium text-foreground/40">Your answer: </span>
                      {userAnswers[step.step_number]}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
