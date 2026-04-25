"use client";

import { useState, useEffect, useRef } from "react";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { Md } from "@/components/ui/Md";
import { Textarea } from "@/components/ui/textarea";
import { useUserTier, canAccess } from "@/lib/UserTierContext";
import { AnalysisProgress } from "@/components/ui/AnalysisProgress";
import { SectionHeader } from "@/components/panel/SectionHeader";
import { SwitchField } from "@/components/ui/switch";

interface QAPanelProps {
  paperId: string;
}

// Static seeds shown on first paint. Once the user has clicked
// through these we ask the model for fresh, paper-specific
// suggestions via `api.suggestQuestions` so the panel never runs
// dry — that's the "regenerate suggestions when the original ones
// run out" request.
const SEED_PROMPTS = [
  "What is the main contribution?",
  "Key limitations?",
  "How does this compare to prior work?",
  "What experiments support the claims?",
  "Practical implications?",
];

const CROSS_PAPER_PROMPTS = [
  "Compare methodologies across papers",
  "What are the common assumptions?",
  "How do the results complement each other?",
  "Identify contradictions between papers",
  "Synthesize key findings",
];

export function QAPanel({ paperId }: QAPanelProps) {
  const {
    questions, addQuestion, removeQuestion, clearQuestions,
    qaResults, setQAResults, qaLoading, setQALoading,
    sessionPapers, bumpUsageRefresh,
    uiPrefs, setHideQaSuggestions, setQADraft,
  } = useStore();
  const { user } = useUserTier();
  const tier = user?.tier || "free";
  const [input, setInput] = useState("");
  const [crossPaper, setCrossPaper] = useState(false);
  const [qaError, setQAError] = useState("");
  const [usedPrompts, setUsedPrompts] = useState<Set<string>>(new Set());
  // Fresh, paper-specific suggestions returned by
  // `api.suggestQuestions`. We append to (rather than replace) the
  // seed list so users keep seeing a growing pool of prompts as they
  // dig deeper into a paper. Stored per-paperId so switching papers
  // shows the right pool immediately.
  const [extraPrompts, setExtraPrompts] = useState<string[]>([]);
  const [extraLoading, setExtraLoading] = useState(false);
  const [extraError, setExtraError] = useState<string | null>(null);
  // Reset suggestion state when the active paper changes — otherwise
  // a paper switch would carry the previous paper's generated
  // prompts (which would be irrelevant and look like a caching bug).
  useEffect(() => {
    setExtraPrompts([]);
    setUsedPrompts(new Set());
    setExtraError(null);
  }, [paperId]);

  const canMultiQA = canAccess(tier, "multi-qa");
  const hasMultiplePapers = sessionPapers.length > 1 && canMultiQA;

  const [justAdded, setJustAdded] = useState(false);
  const justAddedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hideSuggestions = uiPrefs.hideQaSuggestions;
  const toggleSuggestions = () => {
    // Per audit §3.3: route loose localStorage flags through the
    // persisted uiPrefs slice so UI state has one owner.
    setHideQaSuggestions(!hideSuggestions);
  };

  useEffect(() => {
    return () => {
      if (justAddedTimerRef.current) clearTimeout(justAddedTimerRef.current);
    };
  }, []);

  useEffect(() => {
    setInput(uiPrefs.qaDraftByPaper[paperId] || "");
  }, [paperId, uiPrefs.qaDraftByPaper]);

  useEffect(() => {
    setQADraft(paperId, input);
  }, [input, paperId, setQADraft]);

  const handleAdd = () => {
    const q = input.trim();
    if (q) {
      addQuestion(q);
      setInput("");
      setJustAdded(true);
      if (justAddedTimerRef.current) clearTimeout(justAddedTimerRef.current);
      justAddedTimerRef.current = setTimeout(() => setJustAdded(false), 1200);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleAdd(); }
  };

  const [qaErrorKind, setQAErrorKind] = useState<"limit" | "error">("error");

  const handleAnswerAll = async () => {
    if (questions.length === 0) return;
    const toAnswer = [...questions];
    setQALoading(true);
    setQAError("");
    try {
      let result;
      if (crossPaper && hasMultiplePapers) {
        const ids = sessionPapers.map((p) => p.id);
        result = await api.askQuestionsMulti(ids, toAnswer);
      } else {
        result = await api.askQuestions(paperId, toAnswer);
      }
      setQAResults([...qaResults, ...result.items]);
      clearQuestions();
      bumpUsageRefresh();
    } catch (e) {
      const rawMsg = e instanceof Error ? e.message : "Q&A failed";
      const msg = rawMsg.replace(/^API error \d+:\s*/, "").replace(/[{}"]/g, "").replace("detail:", "").trim();
      // Only label the error "Limit reached" when the backend actually said
      // so — otherwise generic network/server failures were getting mis-
      // filed as quota issues, which is misleading and sends users to the
      // billing page for no reason.
      const isLimit = /limit|cap|quota|exceed|too many|upgrade/i.test(msg);
      setQAErrorKind(isLimit ? "limit" : "error");
      setQAError(msg);
    } finally {
      setQALoading(false);
    }
  };

  // Single-paper Q&A pulls from the seed list + any LLM-generated
  // extras. Cross-paper mode keeps its own static list because the
  // generator is tuned per single-paper.
  const prompts = crossPaper && hasMultiplePapers
    ? CROSS_PAPER_PROMPTS
    : [...SEED_PROMPTS, ...extraPrompts];

  const visiblePrompts = prompts.filter((p) => !usedPrompts.has(p));

  const handleGenerateMore = async () => {
    if (extraLoading) return;
    setExtraError(null);
    setExtraLoading(true);
    try {
      // Exclude everything the user has already seen — prompts
      // currently visible AND prompts they've already added — so the
      // generator never serves a duplicate.
      const seen = Array.from(new Set([...prompts, ...questions]));
      const { questions: more } = await api.suggestQuestions(paperId, seen);
      setExtraPrompts((prev) => {
        const merged = [...prev];
        for (const q of more) {
          if (!merged.includes(q) && !SEED_PROMPTS.includes(q)) {
            merged.push(q);
          }
        }
        return merged;
      });
    } catch (e) {
      setExtraError(e instanceof Error ? e.message : "Couldn't fetch more suggestions.");
    } finally {
      setExtraLoading(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <p className="text-[var(--text-sm)] text-muted-foreground">
          Queue questions as you read, then answer them all at once.
        </p>

        {/* Cross-paper toggle */}
        {hasMultiplePapers && (
          <div className="flex items-start gap-3 rounded-lg border border-border/60 bg-card/20 px-3 py-2.5">
            <svg
              className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/80"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
              aria-hidden
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
            </svg>
            <div className="min-w-0 flex-1">
              <p className="text-[var(--text-sm)] font-medium leading-tight text-foreground">
                Cross-Paper Mode
              </p>
              <p className="text-[var(--text-xs)] leading-snug text-muted-foreground/80">
                Ask questions across all {sessionPapers.length} papers in session
              </p>
            </div>
            <SwitchField
              checked={crossPaper}
              onCheckedChange={setCrossPaper}
              aria-label="Toggle cross-paper mode"
            />
          </div>
        )}

        {!qaLoading && (
          <div className="space-y-2">
            <SectionHeader
              title={hideSuggestions ? "Suggestions hidden" : "Suggested questions"}
              action={
                <button
                  type="button"
                  onClick={toggleSuggestions}
                  className="text-[var(--text-xs)] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  aria-pressed={hideSuggestions}
                >
                  {hideSuggestions ? "Show" : "Hide"}
                </button>
              }
            />
            {!hideSuggestions && (
              <div className="flex flex-wrap gap-1.5">
                {visiblePrompts.map((prompt) => (
                  <button
                    // Keying by the prompt text (not the index) keeps
                    // existing pills stable when we append new
                    // suggestions, which prevents React from briefly
                    // flashing a wrong label during the transition.
                    key={prompt}
                    type="button"
                    onClick={() => {
                      addQuestion(prompt);
                      setUsedPrompts((prev) => new Set(prev).add(prompt));
                    }}
                    className="rounded-md border border-border/60 bg-transparent px-2.5 py-1 text-left text-[var(--text-xs)] font-medium text-muted-foreground transition-colors motion-safe:duration-150 motion-safe:ease-out hover:border-border hover:bg-accent/40 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    {prompt}
                  </button>
                ))}
                {/* "Suggest more" appears as a quiet pill alongside
                    the prompts. We surface it always (not just when
                    the seed list is empty) because users sometimes
                    want fresher options before exhausting the seeds —
                    they just stay collapsed visually with a + glyph. */}
                {!crossPaper && (
                  <button
                    type="button"
                    onClick={handleGenerateMore}
                    disabled={extraLoading}
                    className="inline-flex h-[1.75rem] min-w-[1.75rem] items-center justify-center gap-1 rounded-md border border-dashed border-border/70 bg-transparent px-2 text-[var(--text-xs)] font-medium text-muted-foreground transition-colors motion-safe:duration-150 hover:border-border hover:bg-accent/40 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50"
                    title={
                      visiblePrompts.length === 0
                        ? "Generate paper-specific question suggestions"
                        : "Add more paper-specific suggestions"
                    }
                    aria-label={visiblePrompts.length === 0 ? "Suggest questions" : "More like these"}
                  >
                    {extraLoading ? (
                      <>
                        <span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />
                        <span>Thinking…</span>
                      </>
                    ) : (
                      <>
                        <span className="inline-flex h-4 w-4 items-center justify-center rounded border border-border/60 text-[var(--text-xs)] font-semibold leading-none">
                          +
                        </span>
                        {visiblePrompts.length === 0 ? "Suggest questions" : "More like these"}
                      </>
                    )}
                  </button>
                )}
              </div>
            )}
            {extraError && (
              <p role="alert" className="text-[var(--text-xs)] leading-snug text-destructive/90">
                {extraError}
              </p>
            )}
          </div>
        )}

        <Textarea
          placeholder={crossPaper && hasMultiplePapers ? "Ask across all papers..." : "Type a question..."}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={2}
          className="text-[var(--text-md)] resize-none"
        />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleAdd}
            className={
              `h-9 flex-1 rounded-lg border text-[var(--text-sm)] font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ` +
              (justAdded
                ? "border-success/40 bg-success/10 text-success"
                : "border-border bg-transparent text-foreground hover:bg-accent")
            }
          >
            {justAdded ? "✓ Added" : "Add Question"}
          </button>
          <button
            type="button"
            onClick={handleAnswerAll}
            disabled={questions.length === 0 || qaLoading}
            className="btn-primary-glass h-9 flex-1 rounded-lg px-3 text-[var(--text-sm)] font-medium text-background transition-opacity focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40"
          >
            {qaLoading ? "Answering…" : `Answer All (${questions.length})`}
          </button>
        </div>
      </div>

      {qaLoading && (
        <div className="flex min-h-[20vh] flex-col items-center justify-center gap-2 py-4">
          <div className="mx-auto w-full max-w-xs">
            <AnalysisProgress kind="qa" className="mx-auto" />
          </div>
          <p className="text-[var(--text-sm)] text-muted-foreground">
            {crossPaper && hasMultiplePapers ? "Analyzing across papers…" : "Analyzing…"}
          </p>
        </div>
      )}

      {qaError && (
        <div role="alert" className="space-y-1 rounded-lg border border-destructive/20 bg-destructive/10 px-3.5 py-2.5">
          <p className="text-[var(--text-sm)] font-medium text-destructive">
            {qaErrorKind === "limit" ? "Limit reached" : "Couldn't answer"}
          </p>
          <p className="text-[var(--text-xs)] text-destructive/90">{qaError}</p>
        </div>
      )}

      {questions.length > 0 && !qaLoading && (
        <div>
          <SectionHeader title="Queued" count={questions.length} />
          <div className="overflow-hidden rounded-lg border border-border/60 bg-card/30">
            {questions.map((q, i) => (
              <div
                key={i}
                className="flex items-start gap-2 border-b border-border/60 px-4 py-3 last:border-b-0 motion-safe:transition-colors motion-safe:duration-150 hover:bg-accent/40"
              >
                <p className="min-w-0 flex-1 text-[var(--text-md)]">{q}</p>
                <button
                  type="button"
                  onClick={() => removeQuestion(i)}
                  className="shrink-0 text-muted-foreground/50 transition-colors hover:text-destructive focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  aria-label="Remove from queue"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {qaResults.length > 0 && (
        <div className="space-y-4">
          <SectionHeader
            title="Answers"
            count={qaResults.length}
            action={
              <button
                type="button"
                onClick={() => { setQAResults([]); clearQuestions(); setUsedPrompts(new Set()); setQAError(""); }}
                className="text-[var(--text-xs)] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                Clear
              </button>
            }
          />
          {crossPaper && hasMultiplePapers && (
            <p className="text-[var(--text-xs)] text-muted-foreground/80">Cross-paper session</p>
          )}
          {/*
            Newest answer first. Numeric ordinals were dropped at the user's
            request — the visual order now carries the "which is newest"
            affordance, and chronological numbers were misleading after the
            list was inverted anyway.
          */}
          {[...qaResults].reverse().map((item, i) => (
            <div key={qaResults.length - 1 - i} className="space-y-2">
              <p className="px-0.5 text-[var(--text-md)] font-semibold leading-snug">{item.question}</p>
              <div className="border border-border/60 border-l-[3px] border-l-foreground/20 bg-card/40 px-3.5 py-2.5 rounded-r-lg rounded-bl-lg">
                <div className="text-[var(--text-sm)] text-muted-foreground">
                  <Md>{item.answer}</Md>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
