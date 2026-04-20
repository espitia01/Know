"use client";

import { useState, useEffect, memo } from "react";
import { Md } from "@/components/ui/Md";
import type { SelectionAnalysisResult } from "@/lib/api";

function AnalysisProgressBar() {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const interval = setInterval(() => {
      const elapsed = (Date.now() - start) / 1000;
      setWidth(Math.min(90, 90 * (1 - Math.exp(-elapsed / 8))));
    }, 150);
    return () => clearInterval(interval);
  }, []);
  return (
    <div className="w-full h-1 bg-accent rounded-full overflow-hidden">
      <div
        className="h-full bg-foreground/60 rounded-full transition-all duration-200 ease-out"
        style={{ width: `${width}%` }}
      />
    </div>
  );
}

interface SelectionResultPanelProps {
  result: SelectionAnalysisResult | null;
  loading: boolean;
  history: SelectionAnalysisResult[];
  onFollowUp: (question: string, context: string) => Promise<void>;
}

const actionLabels: Record<string, string> = {
  explain: "Explanation",
  derive: "Derivation",
  assumptions: "Assumptions",
  question: "Answer",
  followup: "Follow-up",
};

export function SelectionResultPanel({ result, loading, history, onFollowUp }: SelectionResultPanelProps) {
  const [expandedHistory, setExpandedHistory] = useState<number | null>(null);

  const conversationThread = result
    ? history.filter((h) => h === result || (h.action === "followup" && history.indexOf(h) < history.indexOf(result)))
    : [];

  if (loading && !result) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12">
        <div className="w-full max-w-xs">
          <AnalysisProgressBar />
        </div>
        <span className="text-[13px] text-muted-foreground">Analyzing selection...</span>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {result && (
        <>
          <ResultCard result={result} />
          {loading && (
            <div className="flex flex-col items-center gap-2 py-3">
              <div className="w-full max-w-xs"><AnalysisProgressBar /></div>
              <span className="text-[11px] text-muted-foreground animate-pulse">Processing follow-up...</span>
            </div>
          )}
          <FollowUpInput
            context={result.selected_text}
            onSubmit={onFollowUp}
          />
        </>
      )}

      {history.length > (result ? 1 : 0) && (
        <div className="space-y-2 pt-2 border-t border-border/50">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/50">
            History
          </p>
          {history.slice(result ? 1 : 0).map((item, i) => (
            <div key={i} className="rounded-xl border border-border glass-subtle overflow-hidden">
              <button
                onClick={() => setExpandedHistory(expandedHistory === i ? null : i)}
                className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-accent/30 transition-colors"
              >
                <span className="text-[10px] font-semibold uppercase text-muted-foreground/50 shrink-0">
                  {actionLabels[item.action] || item.action}
                </span>
                <span className="text-[11px] text-muted-foreground/60 truncate flex-1">
                  {item.selected_text.length > 80 ? item.selected_text.slice(0, 80) + "..." : item.selected_text}
                </span>
                <svg
                  className={`w-3 h-3 text-muted-foreground/30 shrink-0 transition-transform ${expandedHistory === i ? "rotate-180" : ""}`}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              {expandedHistory === i && (
                <div className="px-3 pb-3 animate-fade-in">
                  <ResultCard result={item} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FollowUpInput({ context, onSubmit }: { context: string; onSubmit: (q: string, ctx: string) => Promise<void> }) {
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    const q = input.trim();
    if (!q || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(q, context);
      setInput("");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex gap-2 pt-1">
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(); } }}
        placeholder="Ask a follow-up question..."
        disabled={submitting}
        className="flex-1 text-[12px] px-3 py-1.5 rounded-xl border border-border glass-subtle placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
      />
      <button
        onClick={handleSubmit}
        disabled={!input.trim() || submitting}
        className="text-[11px] font-medium px-3 py-1.5 rounded-xl btn-primary-glass text-background transition-opacity disabled:opacity-30 shrink-0"
      >
        {submitting ? "..." : "Ask"}
      </button>
    </div>
  );
}

function ResultCard({ result }: { result: SelectionAnalysisResult }) {
  const isStreaming = result.streaming;
  const hasContent = !!(result.explanation || result.elaboration || result.answer || result.assumptions?.length || result.steps?.length);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
          {actionLabels[result.action] || result.action}
        </span>
        {isStreaming && (
          <span className="text-[10px] text-muted-foreground/40 animate-pulse">streaming...</span>
        )}
      </div>

      <div className="text-[11px] text-muted-foreground/50 glass-subtle px-3 py-2 rounded-xl italic leading-relaxed">
        &ldquo;{result.selected_text.length > 200 ? result.selected_text.slice(0, 200) + "..." : result.selected_text}&rdquo;
      </div>

      {result.explanation && (
        <div className="prose prose-sm dark:prose-invert max-w-none text-[13px] leading-relaxed">
          <Md>{result.explanation}</Md>
          {isStreaming && (
            <span className="inline-block w-1.5 h-4 bg-foreground/60 animate-pulse ml-0.5 align-text-bottom rounded-sm" />
          )}
        </div>
      )}

      {result.elaboration && (
        <div className="prose prose-sm dark:prose-invert max-w-none text-[13px] leading-relaxed">
          <Md>{result.elaboration}</Md>
        </div>
      )}

      {result.answer && (
        <div className="prose prose-sm dark:prose-invert max-w-none text-[13px] leading-relaxed">
          <Md>{result.answer}</Md>
        </div>
      )}

      {!hasContent && isStreaming && (
        <div className="space-y-2 py-4">
          <AnalysisProgressBar />
          <p className="text-[11px] text-muted-foreground animate-pulse text-center">Generating analysis...</p>
        </div>
      )}

      {result.assumptions && result.assumptions.length > 0 && (
        <div className="space-y-2">
          {result.assumptions.map((a, i) => (
            <div key={i} className="glass-subtle rounded-xl px-3 py-2">
              <div className="flex items-start gap-2">
                <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded-lg shrink-0 ${
                  a.type === "explicit"
                    ? "bg-success/15 text-success"
                    : "bg-warning/15 text-warning"
                }`}>
                  {a.type}
                </span>
                <div className="flex-1 text-[12px] leading-relaxed">
                  <Md>{a.statement}</Md>
                  {a.significance && (
                    <div className="text-muted-foreground/60 mt-1 text-[11px]"><Md>{a.significance}</Md></div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {result.steps && result.steps.length > 0 && (
        <DerivationView result={result} />
      )}
    </div>
  );
}

const DerivationView = memo(function DerivationView({ result }: { result: SelectionAnalysisResult }) {
  return (
    <div className="space-y-3">
      {result.starting_point && (
        <div className="glass-subtle rounded-xl px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50 mb-1">Starting Point</p>
          <div className="text-[13px]"><Md>{result.starting_point}</Md></div>
        </div>
      )}

      <div className="space-y-2.5">
        {result.steps!.map((step) => (
          <StepCard key={step.step_number} step={step} />
        ))}
      </div>

      {result.final_result && (
        <div className="bg-success/10 rounded-lg px-3 py-2.5 border border-success/25">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-success mb-1">Final Result</p>
          <div className="text-[13px]"><Md>{result.final_result}</Md></div>
        </div>
      )}
    </div>
  );
});

const StepCard = memo(function StepCard({ step }: { step: NonNullable<SelectionAnalysisResult["steps"]>[0] }) {
  const [showAnswer, setShowAnswer] = useState(false);
  const [showHint, setShowHint] = useState(false);

  return (
    <div className="rounded-xl border border-border glass-subtle overflow-hidden">
      <div className="px-3 py-2 glass">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold text-muted-foreground/50 w-5 h-5 flex items-center justify-center rounded-full glass shrink-0">
            {step.step_number}
          </span>
          <div className="text-[12px] flex-1"><Md>{step.prompt}</Md></div>
        </div>
      </div>
      <div className="px-3 py-2 space-y-2">
        <div className="flex gap-2">
          {!showAnswer && (
            <button
              onClick={() => setShowAnswer(true)}
              className="text-[11px] font-medium text-foreground/70 hover:text-foreground px-2 py-0.5 rounded border border-border hover:bg-accent transition-colors"
            >
              Show Answer
            </button>
          )}
          {!showHint && !showAnswer && (
            <button
              onClick={() => setShowHint(true)}
              className="text-[11px] font-medium text-muted-foreground/50 hover:text-muted-foreground px-2 py-0.5 rounded border border-border/50 hover:bg-accent transition-colors"
            >
              Hint
            </button>
          )}
        </div>
        {showHint && !showAnswer && (
          <div className="text-[11px] text-warning italic bg-warning/10 px-2.5 py-1.5 rounded border border-warning/25">
            <Md>{step.hint}</Md>
          </div>
        )}
        {showAnswer && (
          <div className="space-y-1.5 animate-fade-in">
            <div className="text-[12px] font-medium"><Md>{step.answer}</Md></div>
            <div className="text-[11px] text-muted-foreground/60 leading-relaxed"><Md>{step.explanation}</Md></div>
          </div>
        )}
      </div>
    </div>
  );
});
