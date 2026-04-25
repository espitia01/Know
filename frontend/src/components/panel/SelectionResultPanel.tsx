"use client";

import { useState, memo } from "react";
import { Md } from "@/components/ui/Md";
import { Badge } from "@/components/ui/badge";
import type { SelectionAnalysisResult } from "@/lib/api";
import { ACTION_LABELS, normalizeSelectionAction, selectionKey } from "@/lib/selectionActions";
import { AnalysisProgress } from "@/components/ui/AnalysisProgress";
import { SectionHeader } from "@/components/panel/SectionHeader";

interface SelectionResultPanelProps {
  result: SelectionAnalysisResult | null;
  loading: boolean;
  history: SelectionAnalysisResult[];
  onFollowUp: (question: string, context: string) => Promise<void>;
}

function ThreadGlyph() {
  return (
    <span
      className="mt-0.5 inline-flex h-2.5 w-2.5 shrink-0 items-center justify-center text-[10px] font-normal leading-none text-muted-foreground/40"
      aria-hidden
    >
      ↳
    </span>
  );
}

export function SelectionResultPanel({ result, loading, history, onFollowUp }: SelectionResultPanelProps) {
  const [expandedHistory, setExpandedHistory] = useState<string | null>(null);

  if (loading && !result) {
    return (
      <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 py-12">
        <div className="w-full max-w-xs">
          <AnalysisProgress kind="selection" />
        </div>
        <span className="text-[var(--text-sm)] text-muted-foreground">Analyzing selection…</span>
      </div>
    );
  }

  // Build a "conversation thread" that groups follow-ups under their
  // most recent root selection. Selections list is newest-first so we
  // walk from the *back* (oldest) and accumulate follow-ups against
  // the latest non-followup we've seen. This means a refreshed page
  // reliably shows the original passage with its follow-ups stacked
  // under it instead of as separate top-level history rows — the
  // "follow-ups should thread under the original" request.
  type ThreadNode = {
    root: SelectionAnalysisResult;
    followups: SelectionAnalysisResult[];
    rootKey: string;
  };
  const threads: ThreadNode[] = [];
  const isFollowup = (r: SelectionAnalysisResult) => (r.action ?? "") === "followup";
  // Walk oldest → newest so follow-ups attach to the most recent
  // non-followup that *preceded* them in time. We then reverse the
  // result so the newest thread renders first (matching the rest of
  // the analysis pane's "newest at top" convention).
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (isFollowup(item) && threads.length > 0) {
      threads[threads.length - 1].followups.push(item);
    } else {
      threads.push({
        root: item,
        followups: [],
        rootKey: selectionKey(item),
      });
    }
  }
  threads.reverse();

  // The "active" thread is the one whose root or follow-ups contain
  // the currently displayed `result`. It renders in the main pane
  // (with the follow-up input). Everything else lives under "History."
  const activeKey = result ? selectionKey(result) : null;
  const activeThread = activeKey
    ? threads.find(
        (t) =>
          t.rootKey === activeKey ||
          t.followups.some((f) => selectionKey(f) === activeKey),
      )
    : null;

  const renderThreadCard = (t: ThreadNode) => (
    <div className="space-y-3">
      <ResultCard result={t.root} />
      {t.followups.length > 0 && (
        <div className="ml-3 space-y-3 border-l border-border/70 pl-4">
          {t.followups.map((f) => (
            <div key={selectionKey(f)} className="space-y-2">
              <p className="text-[var(--text-xs)] font-medium text-muted-foreground/75">
                You asked
              </p>
              <div className="flex items-start gap-1.5">
                <ThreadGlyph />
                <p className="text-[var(--text-sm)] font-medium leading-snug text-foreground">
                  {f.question || f.selected_text}
                </p>
              </div>
              <ResultCard result={f} hideHeader hideQuote />
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-6">
      {result && activeThread && (
        <>
          {renderThreadCard(activeThread)}
          {loading && (
            <div className="flex flex-col items-center gap-2 py-3">
              <div className="w-full max-w-xs">
                <AnalysisProgress kind="selection" />
              </div>
              <span className="text-[var(--text-xs)] text-muted-foreground motion-safe:animate-pulse">Processing follow-up…</span>
            </div>
          )}
          <FollowUpInput
            context={activeThread.root.selected_text}
            onSubmit={onFollowUp}
          />
        </>
      )}

      {/* History: every thread except the active one. Sorting + key
          stability are deliberate — the previous implementation
          re-keyed by index, which made the panel "shuffle" entries on
          every store update because React mistook them for moves. */}
      {threads.filter((t) => t !== activeThread).length > 0 && (
        <div className="space-y-2 border-t border-border/50 pt-2">
          <SectionHeader title="History" count={threads.filter((t) => t !== activeThread).length} />
          <div className="overflow-hidden rounded-lg border border-border/60 bg-card/30">
            {threads
              .filter((t) => t !== activeThread)
              .map((t) => {
                const isExpanded = expandedHistory === t.rootKey;
                const action = normalizeSelectionAction(t.root.action);
                return (
                  <div key={t.rootKey} className="border-b border-border/60 last:border-b-0">
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedHistory(isExpanded ? null : t.rootKey)
                      }
                      className="flex w-full items-center gap-2 px-4 py-3 text-left motion-safe:transition-colors motion-safe:duration-150 hover:bg-accent/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                      <span
                        className="shrink-0 text-[var(--text-2xs)] font-medium tracking-wide"
                        data-action={action}
                        style={{
                          // Inline so the badge color tracks the same
                          // per-action palette as the PDF underlines.
                          // Fallback to the muted text token if the
                          // action isn't one we know.
                          color: "rgb(var(--highlight-rgb, var(--muted-foreground-rgb, 113 113 122)))",
                          background:
                            "rgb(var(--highlight-rgb, var(--muted-foreground-rgb, 113 113 122)) / 0.12)",
                        }}
                      >
                        {ACTION_LABELS[action] || action}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[var(--text-xs)] text-muted-foreground/80">
                        {t.root.selected_text.length > 80
                          ? t.root.selected_text.slice(0, 80) + "…"
                          : t.root.selected_text}
                      </span>
                      {t.followups.length > 0 && (
                        <span className="shrink-0 font-mono text-[0.7rem] font-light tabular-nums text-muted-foreground/60">
                          +{t.followups.length}
                        </span>
                      )}
                      <svg
                        className={`h-3 w-3 shrink-0 text-muted-foreground/30 motion-safe:transition-transform ${isExpanded ? "rotate-180" : ""}`}
                        fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                        aria-hidden
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>
                    {isExpanded && (
                      <div className="border-t border-border/40 px-4 pb-3 motion-safe:animate-fade-in">
                        {renderThreadCard(t)}
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
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
        placeholder="Ask a follow-up question…"
        disabled={submitting}
        className="min-h-9 flex-1 rounded-lg border border-border/80 bg-card/30 px-3 py-1.5 text-[var(--text-sm)] placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring/40 disabled:opacity-50"
      />
      <button
        type="button"
        onClick={handleSubmit}
        disabled={!input.trim() || submitting}
        className="btn-primary-glass h-9 shrink-0 rounded-lg px-3 text-[var(--text-xs)] font-medium text-background transition-opacity focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40"
      >
        {submitting ? "…" : "Ask"}
      </button>
    </div>
  );
}

function ResultCard({
  result,
  hideHeader = false,
  hideQuote = false,
}: {
  result: SelectionAnalysisResult;
  hideHeader?: boolean;
  hideQuote?: boolean;
}) {
  const isStreaming = result.streaming;
  const hasContent = !!(result.explanation || result.elaboration || result.answer || result.assumptions?.length || result.steps?.length);
  const action = normalizeSelectionAction(result.action);

  return (
    <div className="space-y-3">
      {!hideHeader && (
        <div className="flex items-center gap-2">
          <span
            className="text-[var(--text-2xs)] font-medium tracking-wide"
            data-action={action}
            style={{
              color: "rgb(var(--highlight-rgb, var(--muted-foreground-rgb, 113 113 122)))",
              background:
                "rgb(var(--highlight-rgb, var(--muted-foreground-rgb, 113 113 122)) / 0.12)",
            }}
          >
            {ACTION_LABELS[action] || action}
          </span>
          {isStreaming && (
            <span className="text-[var(--text-xs)] text-muted-foreground/50 motion-safe:animate-pulse">streaming…</span>
          )}
        </div>
      )}

      {!hideQuote && (
        <div className="text-[var(--text-xs)] leading-relaxed text-muted-foreground/60">
          <span className="italic">
            &ldquo;{result.selected_text.length > 200 ? result.selected_text.slice(0, 200) + "…" : result.selected_text}&rdquo;
          </span>
        </div>
      )}

      {(result.explanation || result.elaboration || result.answer) && (
        <div className="rounded-lg border border-border/60 border-l-[3px] border-l-foreground/20 bg-card/40 px-3.5 py-2.5">
          {result.explanation && (
            <div className="prose prose-sm max-w-none text-[var(--text-md)] leading-relaxed dark:prose-invert">
              <Md>{result.explanation}</Md>
              {isStreaming && (
                <span className="ml-0.5 inline-block h-4 w-1.5 align-text-bottom rounded-sm bg-foreground/60 motion-safe:animate-pulse" />
              )}
            </div>
          )}
          {result.elaboration && (
            <div className="prose prose-sm max-w-none text-[var(--text-md)] leading-relaxed dark:prose-invert">
              <Md>{result.elaboration}</Md>
            </div>
          )}
          {result.answer && (
            <div className="prose prose-sm max-w-none text-[var(--text-md)] leading-relaxed dark:prose-invert">
              <Md>{result.answer}</Md>
            </div>
          )}
        </div>
      )}

      {!hasContent && isStreaming && (
        <div className="space-y-2 py-4">
          <AnalysisProgress kind="selection" />
          <p className="text-center text-[var(--text-xs)] text-muted-foreground motion-safe:animate-pulse">Generating analysis…</p>
        </div>
      )}

      {result.assumptions && result.assumptions.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-border/60">
          {result.assumptions.map((a, i) => (
            <div
              key={i}
              className="border-b border-border/60 px-4 py-3 last:border-b-0 motion-safe:transition-colors motion-safe:duration-150 hover:bg-accent/40"
            >
              <div className="flex items-start gap-2">
                <Badge
                  variant={a.type === "explicit" ? "soft" : "outline"}
                  className={a.type === "explicit" ? "text-success" : "text-warning"}
                >
                  {a.type}
                </Badge>
                <div className="min-w-0 flex-1 text-[var(--text-sm)] leading-relaxed">
                  <Md>{a.statement}</Md>
                  {a.significance && (
                    <div className="mt-1 text-[var(--text-xs)] text-muted-foreground/80">
                      <Md>{a.significance}</Md>
                    </div>
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
        <div className="rounded-lg border border-border/60 bg-card/30 px-3 py-2.5">
          <p className="mb-1 text-[var(--text-xs)] font-semibold text-muted-foreground/80">Starting point</p>
          <div className="text-[var(--text-md)]">
            <Md>{result.starting_point}</Md>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {result.steps!.map((step) => (
          <StepCard key={step.step_number} step={step} />
        ))}
      </div>

      {result.final_result && (
        <div className="rounded-lg border border-success/30 bg-card/30 px-3 py-2.5 ring-1 ring-success/10">
          <p className="mb-1 text-[var(--text-xs)] font-semibold text-success">Final result</p>
          <div className="text-[var(--text-md)]">
            <Md>{result.final_result}</Md>
          </div>
        </div>
      )}
    </div>
  );
});

const StepCard = memo(function StepCard({ step }: { step: NonNullable<SelectionAnalysisResult["steps"]>[0] }) {
  const [showAnswer, setShowAnswer] = useState(false);
  const [showHint, setShowHint] = useState(false);

  return (
    <div className="overflow-hidden rounded-lg border border-border/60 bg-card/30">
      <div className="border-b border-border/50 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border/60 text-[var(--text-xs)] font-medium text-muted-foreground/80">
            {step.step_number}
          </span>
          <div className="min-w-0 flex-1 text-[var(--text-sm)]">
            <Md>{step.prompt}</Md>
          </div>
        </div>
      </div>
      <div className="space-y-2 px-3 py-2">
        <div className="flex flex-wrap gap-2">
          {!showAnswer && (
            <button
              type="button"
              onClick={() => setShowAnswer(true)}
              className="h-8 rounded-lg border border-border bg-transparent px-2.5 text-[var(--text-xs)] font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              Show answer
            </button>
          )}
          {!showHint && !showAnswer && (
            <button
              type="button"
              onClick={() => setShowHint(true)}
              className="text-[var(--text-xs)] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              Hint
            </button>
          )}
        </div>
        {showHint && !showAnswer && (
          <div className="rounded-md border border-warning/30 bg-warning/10 px-2.5 py-1.5 text-[var(--text-xs)] italic text-warning">
            <Md>{step.hint}</Md>
          </div>
        )}
        {showAnswer && (
          <div className="space-y-2 motion-safe:animate-fade-in">
            <div className="text-[var(--text-sm)] font-medium">
              <Md>{step.answer}</Md>
            </div>
            <div className="text-[var(--text-xs)] leading-relaxed text-muted-foreground/80">
              <Md>{step.explanation}</Md>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});
