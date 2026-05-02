"use client";

import { useState, memo, useEffect, useRef } from "react";
import { Md } from "@/components/ui/Md";
import { Badge } from "@/components/ui/badge";
import type { SelectionAnalysisResult } from "@/lib/api";
import { ACTION_LABELS, normalizeSelectionAction, selectionKey } from "@/lib/selectionActions";
import { AnalysisProgress } from "@/components/ui/AnalysisProgress";
import { SectionHeader } from "@/components/panel/SectionHeader";
import { AnalysisAccordionRow } from "@/components/panel/AnalysisAccordionRow";
import { useStore } from "@/lib/store";

interface SelectionResultPanelProps {
  result: SelectionAnalysisResult | null;
  loading: boolean;
  history: SelectionAnalysisResult[];
  onFollowUp: (question: string, context: string) => Promise<void>;
  /** When false, hides the follow-up composer (e.g. anonymous trial). */
  allowFollowUp?: boolean;
  /** Overrides store `openSelectionFromHistory` (e.g. demo uses local React state). */
  onFocusHistoryRoot?: (root: SelectionAnalysisResult) => void;
}

function FollowUpThreadList({ followups }: { followups: SelectionAnalysisResult[] }) {
  const prevCount = useRef(0);
  const [openKey, setOpenKey] = useState<string | null>(null);

  useEffect(() => {
    const n = followups.length;
    const last = n ? selectionKey(followups[n - 1]) : null;
    if (n > prevCount.current && last) {
      setOpenKey(last);
    } else if (n === 0) {
      setOpenKey(null);
    } else {
      setOpenKey((k) => {
        if (!k) return k;
        return followups.some((f) => selectionKey(f) === k) ? k : last;
      });
    }
    prevCount.current = n;
  }, [followups]);

  if (followups.length === 0) return null;

  return (
    <div className="space-y-2">
      {followups.map((f, i) => {
        const k = selectionKey(f);
        const open = openKey === k;
        const q = f.question || f.selected_text;
        return (
          <AnalysisAccordionRow
            key={k}
            open={open}
            onOpenChange={(next) => setOpenKey(next ? k : null)}
            title={q}
            leading={
              <span
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border/50 bg-background/60 text-[10px] font-medium tabular-nums text-muted-foreground dark:bg-card/30"
                aria-hidden
              >
                {i + 1}
              </span>
            }
          >
            <ResultCard result={f} hideHeader hideQuote />
          </AnalysisAccordionRow>
        );
      })}
    </div>
  );
}

export function SelectionResultPanel({
  result,
  loading,
  history,
  onFollowUp,
  allowFollowUp = true,
  onFocusHistoryRoot,
}: SelectionResultPanelProps) {
  const openSelectionFromHistory = useStore((s) => s.openSelectionFromHistory);
  const focusHistoryRoot = onFocusHistoryRoot ?? openSelectionFromHistory;

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

  const canAskFollowUp =
    allowFollowUp && !!result && !result.streaming && !loading;

  const renderThreadCard = (t: ThreadNode) => (
    <div className="space-y-4">
      <ResultCard result={t.root} />
      {t.followups.length > 0 && (
        <div>
          <SectionHeader title="Follow-ups" count={t.followups.length} className="mb-2" />
          <FollowUpThreadList followups={t.followups} />
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-8">
      {result && activeThread && (
        <>
          {renderThreadCard(activeThread)}
          {loading && (
            <div className="flex w-full flex-col items-center gap-2.5 rounded-lg border border-border/55 bg-muted/10 px-4 py-5 dark:bg-muted/[0.08]">
              <div className="w-full max-w-xs">
                <AnalysisProgress kind="selection" className="mx-auto" />
              </div>
              <span className="text-center text-[var(--text-xs)] text-muted-foreground motion-safe:animate-pulse">
                Thinking…
              </span>
            </div>
          )}
          {canAskFollowUp && (
            <div className="border-t border-border/50 pt-4">
              <p className="mb-2 text-[11px] font-medium text-muted-foreground">
                Ask a follow-up about this passage
              </p>
              <FollowUpInput
                context={activeThread.root.selected_text}
                onSubmit={onFollowUp}
              />
            </div>
          )}
        </>
      )}

      {/* History: every thread except the active one — click a row to focus it so follow-ups attach here. */}
      {threads.filter((t) => t !== activeThread).length > 0 && (
        <div className="space-y-2 border-t border-border/50 pt-6">
          <SectionHeader title="History" count={threads.filter((t) => t !== activeThread).length} />
          <div className="overflow-hidden rounded-lg border border-border/60 bg-card/45 divide-y divide-border/50 dark:border-border/55 dark:bg-card/22">
            {threads
              .filter((t) => t !== activeThread)
              .map((t) => {
                const action = normalizeSelectionAction(t.root.action);
                return (
                  <div key={t.rootKey}>
                    <button
                      type="button"
                      onClick={() => focusHistoryRoot(t.root)}
                      className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors duration-150 hover:bg-accent/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                      <span
                        className="shrink-0 rounded-md px-2 py-0.5 text-[10px] font-medium tracking-wide"
                        data-action={action}
                        style={{
                          color: "rgb(var(--highlight-rgb, var(--muted-foreground-rgb, 113 113 122)))",
                          background:
                            "rgb(var(--highlight-rgb, var(--muted-foreground-rgb, 113 113 122)) / 0.12)",
                        }}
                      >
                        {ACTION_LABELS[action] || action}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
                        {t.root.selected_text.length > 80
                          ? t.root.selected_text.slice(0, 80) + "…"
                          : t.root.selected_text}
                      </span>
                      {t.followups.length > 0 && (
                        <span className="shrink-0 font-mono text-[10px] font-normal tabular-nums text-muted-foreground/65">
                          +{t.followups.length}
                        </span>
                      )}
                      <span className="shrink-0 text-[10px] font-medium tracking-wide text-muted-foreground/60">
                        Open
                      </span>
                    </button>
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
    <div className="flex gap-2">
      <input
        type="search"
        name="know_selection_followup"
        autoComplete="off"
        autoCorrect="on"
        spellCheck
        enterKeyHint="send"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(); } }}
        placeholder="Ask a follow-up question…"
        disabled={submitting}
        className="know-non-credential-input min-h-9 flex-1 rounded-lg border border-border/65 bg-background/85 px-3 py-2 text-[var(--text-sm)] shadow-none placeholder:text-muted-foreground/55 focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:opacity-50 dark:bg-card/28"
      />
      <button
        type="button"
        onClick={handleSubmit}
        disabled={!input.trim() || submitting}
        className="btn-primary-glass h-9 shrink-0 rounded-lg px-3.5 text-[var(--text-xs)] font-semibold text-background transition-opacity focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40"
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
  const streamingLabel = action === "followup" ? "Thinking…" : "Generating analysis…";
  const inAccordion = hideHeader && hideQuote;

  return (
    <div className="space-y-3">
      {!hideHeader && (
        <div className="flex items-center gap-2">
          <span
            className="rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
            data-action={action}
            style={{
              color: "rgb(var(--highlight-rgb, var(--muted-foreground-rgb, 113 113 122)))",
              background:
                "rgb(var(--highlight-rgb, var(--muted-foreground-rgb, 113 113 122)) / 0.14)",
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
        <div className="rounded-lg border border-border/40 bg-muted/20 px-3 py-2.5 text-[var(--text-xs)] leading-relaxed text-muted-foreground/75">
          <span className="italic text-foreground/85">
            &ldquo;{result.selected_text.length > 200 ? result.selected_text.slice(0, 200) + "…" : result.selected_text}&rdquo;
          </span>
        </div>
      )}

      {(result.explanation || result.elaboration || result.answer) && (
        <div
          className={
            inAccordion
              ? "rounded-md border border-border/45 bg-background/55 px-3 py-2.5 dark:bg-card/22"
              : "rounded-lg border border-border/50 bg-card/50 px-3.5 py-3 dark:bg-card/32"
          }
        >
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
        <div className="flex w-full flex-col items-center gap-2 py-4">
          <div className="w-full max-w-xs">
            <AnalysisProgress kind="selection" className="mx-auto" />
          </div>
          <p className="text-center text-[var(--text-xs)] text-muted-foreground motion-safe:animate-pulse">
            {streamingLabel}
          </p>
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
