"use client";

import { useState, memo, useEffect, useRef } from "react";
// Stage 2: migrated selection-stream paths render via Streamdown
// (KaTeX math + streaming carets baked in). The legacy `<Md>` is still
// imported elsewhere for the Notes path; we just don't reach for it
// here anymore.
import { StreamingMarkdown } from "@/components/analysis/StreamingMarkdown";
import { Badge } from "@/components/ui/badge";
import type { SelectionAnalysisResult } from "@/lib/api";
import { ACTION_LABELS, normalizeSelectionAction, selectionKey } from "@/lib/selectionActions";
import { hasMathInText } from "@/lib/selectionMath";
import { AnalysisProgress } from "@/components/ui/AnalysisProgress";
import { SectionHeader } from "@/components/panel/SectionHeader";
import { AnalysisSection } from "@/components/analysis/AnalysisSection";
import { CardMeta } from "@/components/analysis/CardMeta";
import { ReadMoreProse } from "@/components/analysis/ReadMoreProse";
import { AnalysisAccordionRow } from "@/components/panel/AnalysisAccordionRow";
import { useStore } from "@/lib/store";
import { ModelOverridePill } from "@/components/analysis/ModelOverridePill";
import { ModelPill } from "@/components/analysis/ModelPill";
import { useUserSettings } from "@/lib/UserSettingsContext";
import { api } from "@/lib/api";

/**
 * The user's literal `selected_text` is sometimes alphabet-soup glyphs from
 * the PDF text layer when they selected an equation. Showing that as a quote
 * looks broken — we render a neutral placeholder instead. `hasMathInText`
 * already detects this pattern (PDF-garbled math + Unicode + LaTeX cues).
 */
function looksLikePdfGarbled(text: string | undefined | null): boolean {
  if (!text) return false;
  if (!hasMathInText(text)) return false;
  // Equations with normal punctuation are still readable; the truly garbled
  // case has almost no real words. Tokens with ≥3 alphabetic chars and a
  // vowel are a good proxy for readable words.
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  const wordy = tokens.filter((t) => /^[A-Za-z]{3,}$/.test(t) && /[aeiouAEIOU]/.test(t)).length;
  return wordy / tokens.length < 0.25;
}

interface SelectionResultPanelProps {
  result: SelectionAnalysisResult | null;
  loading: boolean;
  history: SelectionAnalysisResult[];
  onFollowUp: (question: string, context: string) => Promise<void>;
  followUpModel?: string;
  followUpAllowedModels?: string[];
  onFollowUpModelChange?: (slug: string) => void;
  /** When false, hides the follow-up composer (e.g. anonymous trial). */
  allowFollowUp?: boolean;
  /** Overrides store `openSelectionFromHistory` (e.g. demo uses local React state). */
  onFocusHistoryRoot?: (root: SelectionAnalysisResult) => void;
  /** Required when using the default `openSelectionFromHistory` store action. */
  paperId?: string;
}

function FollowUpThreadList({
  followups,
  onDelete,
}: {
  followups: SelectionAnalysisResult[];
  onDelete?: (followup: SelectionAnalysisResult) => void;
}) {
  const prevCount = useRef(0);
  const [openKey, setOpenKey] = useState<string | null>(null);

  /** Stable digest for effect deps — `followups` array identity churns each parent render. */
  const followSig = `${followups.length}\x1f${followups.map((f) => selectionKey(f)).join("\x1e")}`;

  useEffect(() => {
    const n = followups.length;
    const lastKey = n > 0 ? selectionKey(followups[n - 1]) : null;
    if (n === 0) {
      setOpenKey(null);
      prevCount.current = 0;
      return;
    }
    if (n > prevCount.current && lastKey) {
      setOpenKey(lastKey);
      prevCount.current = n;
      return;
    }
    prevCount.current = n;
    setOpenKey((k) => {
      if (!lastKey) return k;
      if (!k || !followups.some((f) => selectionKey(f) === k)) return lastKey;
      return k;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- followSig encodes followups identities
  }, [followSig]);

  if (followups.length === 0) return null;

  return (
    <div className="space-y-2">
      {followups.map((f, i) => {
        const k = selectionKey(f);
        const open = openKey === k;
        const q = f.question || f.selected_text;
        return (
          <div key={k} className="group/follow relative">
            <AnalysisAccordionRow
              open={open}
              onOpenChange={(next) => setOpenKey(next ? k : null)}
              title={
                <span className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">{q}</span>
                  {f.model && (
                    <ModelPill slug={f.model} pending={!!f.streaming} />
                  )}
                </span>
              }
              leading={
                <span
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-muted/35 text-[10px] font-medium tabular-nums text-muted-foreground"
                  aria-hidden
                >
                  {i + 1}
                </span>
              }
            >
              <ResultCard result={f} hideHeader hideQuote />
            </AnalysisAccordionRow>
            {onDelete && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(f);
                }}
                aria-label="Delete this follow-up"
                title="Delete follow-up"
                className="absolute right-2 top-2 rounded-md p-1.5 text-muted-foreground/55 opacity-0 transition-opacity duration-150 hover:bg-destructive/15 hover:text-destructive focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring group-hover/follow:opacity-100 group-focus-within/follow:opacity-100"
              >
                <svg
                  className="h-3.5 w-3.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.8}
                  aria-hidden
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
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
  followUpModel,
  followUpAllowedModels,
  onFollowUpModelChange,
  allowFollowUp = true,
  onFocusHistoryRoot,
  paperId,
}: SelectionResultPanelProps) {
  const openSelectionFromHistory = useStore((s) => s.openSelectionFromHistory);
  const removeSelectionFromHistoryForPaper = useStore(
    (s) => s.removeSelectionFromHistoryForPaper,
  );
  const focusHistoryRoot =
    onFocusHistoryRoot ??
    ((root: SelectionAnalysisResult) => {
      if (paperId) openSelectionFromHistory(paperId, root);
    });

  const handleDeleteHistoryRoot = (root: SelectionAnalysisResult) => {
    if (!paperId) return;
    removeSelectionFromHistoryForPaper(paperId, root);
    void api
      .deleteSelection(paperId, root.selected_text ?? "", root.action ?? "explain")
      .catch(() => {});
  };

  const handleDeleteFollowUp = (followup: SelectionAnalysisResult) => {
    if (!paperId) return;
    removeSelectionFromHistoryForPaper(paperId, followup);
    void api
      .deleteSelection(paperId, followup.selected_text ?? "", followup.action ?? "followup")
      .catch(() => {});
  };

  if (loading && !result) {
    return (
      <div className="flex flex-col items-center gap-2 py-6">
        <div className="w-full max-w-[16rem]">
          <AnalysisProgress kind="selection" />
        </div>
        <p className="text-[var(--text-xs)] text-muted-foreground/85">Analyzing selection…</p>
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
          <SectionHeader title="Follow-ups" count={t.followups.length} eyebrow className="mb-2" />
          <FollowUpThreadList
            followups={t.followups}
            onDelete={paperId ? handleDeleteFollowUp : undefined}
          />
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-8">
      {result && activeThread && (
        <>
          {/* ResultCard owns its own empty/streaming indicator —
              don't duplicate it at the panel level. */}
          {renderThreadCard(activeThread)}
          {canAskFollowUp && (
            <div className="border-t border-border/50 pt-4">
              <p className="mb-2 text-[11px] font-medium text-muted-foreground">
                Ask a follow-up about this passage
              </p>
              <FollowUpInput
                context={activeThread.root.selected_text}
                onSubmit={onFollowUp}
                model={followUpModel}
                allowedModels={followUpAllowedModels}
                onModelChange={onFollowUpModelChange}
              />
            </div>
          )}
        </>
      )}

      {/* History: every thread except the active one — click a row to focus it so follow-ups attach here. */}
      {threads.filter((t) => t !== activeThread).length > 0 && (
        <div className="space-y-2 border-t border-border/50 pt-6">
          <SectionHeader title="History" count={threads.filter((t) => t !== activeThread).length} eyebrow />
          <div className="overflow-hidden rounded-[var(--radius-lg)] border border-border/50 bg-card/35 divide-y divide-border/40 dark:bg-card/22">
            {threads
              .filter((t) => t !== activeThread)
              .map((t) => {
                const action = normalizeSelectionAction(t.root.action);
                return (
                  <div key={t.rootKey} className="group/row relative flex">
                    <button
                      type="button"
                      onClick={() => focusHistoryRoot(t.root)}
                      className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 pr-10 text-left transition-colors duration-150 hover:bg-accent/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                      <span
                        className="shrink-0 rounded-full border border-border/55 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/85"
                        data-action={action}
                      >
                        {ACTION_LABELS[action] || action}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
                        {looksLikePdfGarbled(t.root.selected_text)
                          ? "Equation from selected passage"
                          : t.root.selected_text.length > 80
                            ? t.root.selected_text.slice(0, 80) + "…"
                            : t.root.selected_text}
                      </span>
                      {t.followups.length > 0 && (
                        <span className="shrink-0 font-mono text-[10px] font-normal tabular-nums text-muted-foreground/65">
                          +{t.followups.length}
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteHistoryRoot(t.root);
                      }}
                      aria-label="Delete this analysis"
                      title="Delete"
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted-foreground/55 opacity-0 transition-opacity duration-150 hover:bg-destructive/15 hover:text-destructive focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring group-hover/row:opacity-100 group-focus-within/row:opacity-100"
                    >
                      <svg
                        className="h-3.5 w-3.5"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={1.8}
                        aria-hidden
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
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

function FollowUpInput({
  context,
  onSubmit,
  model,
  allowedModels,
  onModelChange,
}: {
  context: string;
  onSubmit: (q: string, ctx: string) => Promise<void>;
  model?: string;
  allowedModels?: string[];
  onModelChange?: (slug: string) => void;
}) {
  const { fastModel, allowedModels: defaultAllowed } = useUserSettings();
  const resolvedModel = model ?? fastModel;
  const resolvedAllowed = allowedModels ?? defaultAllowed;
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
      {onModelChange && resolvedAllowed.length > 0 && (
        <ModelOverridePill
          model={resolvedModel}
          allowed={resolvedAllowed}
          onChange={onModelChange}
        />
      )}
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
        className="know-non-credential-input min-h-9 flex-1 rounded-[var(--radius-md)] border border-input bg-muted/30 px-3 py-2 text-[var(--text-sm)] placeholder:text-muted-foreground/55 focus-visible:border-ring focus-visible:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50 dark:bg-muted/20"
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
  const { fastModel } = useUserSettings();
  const isStreaming = result.streaming;
  const resolvedModel = result.model ?? fastModel;
  const modelPending = isStreaming && !result.model;
  const hasContent = !!(result.explanation || result.elaboration || result.answer || result.assumptions?.length || result.steps?.length);
  const action = normalizeSelectionAction(result.action);
  const streamingLabel = "Thinking…";
  return (
    <div className="space-y-3">
      {!hideHeader && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span
            className="text-[10px] font-medium uppercase tracking-[0.14em]"
            data-action={action}
            style={{
              color: "rgb(var(--highlight-rgb, var(--muted-foreground-rgb, 113 113 122)) / 0.85)",
            }}
          >
            {ACTION_LABELS[action] || action}
          </span>
          <div className="flex items-center gap-2">
            <CardMeta model={resolvedModel} createdAt={result.created_at} pending={modelPending} />
            {isStreaming && hasContent && (
              <span className="text-[var(--text-xs)] text-muted-foreground/50 motion-safe:animate-pulse">Thinking…</span>
            )}
          </div>
        </div>
      )}

      {!hideQuote && (
        <div className="border-l-2 border-border/50 pl-3 text-[var(--text-sm)] italic text-foreground/80 dark:text-foreground/75">
          {looksLikePdfGarbled(result.selected_text) ? (
            <span className="not-italic text-muted-foreground/75">
              Equation from selected passage
            </span>
          ) : (
            <>
              &ldquo;
              {result.selected_text.length > 200
                ? result.selected_text.slice(0, 200) + "…"
                : result.selected_text}
              &rdquo;
            </>
          )}
        </div>
      )}

      {(result.explanation || result.elaboration || result.answer) && (
        <div className="text-[var(--text-sm)] leading-relaxed text-foreground/90">
          {result.explanation && (
            <ReadMoreProse markdown={result.explanation} streaming={isStreaming}>
              <StreamingMarkdown streaming={isStreaming}>
                {result.explanation}
              </StreamingMarkdown>
            </ReadMoreProse>
          )}
          {result.elaboration && (
            <StreamingMarkdown>{result.elaboration}</StreamingMarkdown>
          )}
          {result.answer && (
            <StreamingMarkdown>{result.answer}</StreamingMarkdown>
          )}
        </div>
      )}

      {!hasContent && isStreaming && (
        <div className="flex flex-col items-center gap-2 py-6">
          <div className="w-full max-w-[16rem]">
            <AnalysisProgress kind="selection" />
          </div>
          <p className="text-[var(--text-xs)] text-muted-foreground/85">{streamingLabel}</p>
        </div>
      )}

      {result.assumptions && result.assumptions.length > 0 && (
        <AnalysisSection title="Assumptions" count={result.assumptions.length}>
          <div className="overflow-hidden rounded-lg border border-border/50 bg-card/45 divide-y divide-border/50 dark:bg-card/22">
            {result.assumptions.map((a, i) => (
              <div
                key={i}
                data-type={a.type}
                className="px-3 py-2.5 motion-safe:transition-colors motion-safe:duration-150 hover:bg-accent/40"
              >
                <div className="flex items-start gap-2">
                  <Badge
                    variant={a.type === "explicit" ? "soft" : "outline"}
                    className={a.type === "explicit" ? "text-success" : "text-warning"}
                  >
                    {a.type}
                  </Badge>
                  <div className="min-w-0 flex-1 text-[var(--text-sm)] leading-relaxed text-foreground/90">
                    <StreamingMarkdown>{a.statement}</StreamingMarkdown>
                    {a.significance && (
                      <div className="mt-1 text-[var(--text-xs)] text-muted-foreground/80">
                        <StreamingMarkdown>{a.significance}</StreamingMarkdown>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </AnalysisSection>
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
          <StreamingMarkdown>{result.starting_point}</StreamingMarkdown>
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
          <StreamingMarkdown>{result.final_result}</StreamingMarkdown>
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
            <StreamingMarkdown>{step.prompt}</StreamingMarkdown>
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
        {showHint && !showAnswer && step.hint && (
          <div className="rounded-md border border-warning/30 bg-warning/10 px-2.5 py-1.5 text-[var(--text-xs)] italic text-warning">
            <StreamingMarkdown>{step.hint}</StreamingMarkdown>
          </div>
        )}
        {showAnswer && (
          <div className="space-y-2 motion-safe:animate-fade-in">
            <div className="text-[var(--text-sm)] font-medium">
              <StreamingMarkdown>{step.answer}</StreamingMarkdown>
            </div>
            <div className="text-[var(--text-xs)] leading-relaxed text-muted-foreground/80">
              <StreamingMarkdown>{step.explanation}</StreamingMarkdown>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});
