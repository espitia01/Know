"use client";

import { useState, useEffect, useRef } from "react";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { Md } from "@/components/ui/Md";
import { Textarea } from "@/components/ui/textarea";
import { useUserTier, canAccess } from "@/lib/UserTierContext";

interface QAPanelProps {
  paperId: string;
}

function ProgressBar() {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const interval = setInterval(() => {
      const elapsed = (Date.now() - start) / 1000;
      setWidth(Math.min(90, 90 * (1 - Math.exp(-elapsed / 10))));
    }, 150);
    return () => clearInterval(interval);
  }, []);
  return (
    <div className="w-full max-w-xs h-1 bg-accent rounded-full overflow-hidden mx-auto">
      <div className="h-full bg-foreground/60 rounded-full transition-all duration-200 ease-out" style={{ width: `${width}%` }} />
    </div>
  );
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
      <div className="space-y-2.5">
        <p className="text-[13px] text-muted-foreground">
          Queue questions as you read, then answer them all at once.
        </p>

        {/* Cross-paper toggle */}
        {hasMultiplePapers && (
          <button
            onClick={() => setCrossPaper(!crossPaper)}
            className={`flex items-center gap-2 w-full px-3 py-2 rounded-lg border transition-all text-left ${
              crossPaper
                ? "border-foreground/20 bg-foreground/5"
                : "border-border/50 bg-transparent hover:border-border"
            }`}
          >
            <div className={`w-7 h-4 rounded-full transition-colors relative shrink-0 ${
              crossPaper ? "bg-foreground" : "bg-muted-foreground/20"
            }`}>
              <div className={`absolute top-0.5 w-3 h-3 rounded-full bg-background shadow-sm transition-all ${
                crossPaper ? "left-3.5" : "left-0.5"
              }`} />
            </div>
            <div>
              <p className="text-[12px] font-medium leading-tight">
                Cross-Paper Mode
              </p>
              <p className="text-[10px] text-muted-foreground/50 leading-tight">
                Ask questions across all {sessionPapers.length} papers in session
              </p>
            </div>
          </button>
        )}

        {!qaLoading && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
                {hideSuggestions ? "Suggestions hidden" : "Suggested questions"}
              </p>
              <button
                onClick={toggleSuggestions}
                className="text-[10px] font-medium text-muted-foreground/60 hover:text-foreground transition-colors"
                aria-pressed={hideSuggestions}
              >
                {hideSuggestions ? "Show" : "Hide"}
              </button>
            </div>
            {!hideSuggestions && (
              <div className="flex flex-wrap gap-1.5">
                {visiblePrompts.map((prompt) => (
                  <button
                    // Keying by the prompt text (not the index) keeps
                    // existing pills stable when we append new
                    // suggestions, which prevents React from briefly
                    // flashing a wrong label during the transition.
                    key={prompt}
                    onClick={() => {
                      addQuestion(prompt);
                      setUsedPrompts((prev) => new Set(prev).add(prompt));
                    }}
                    className="text-[11px] px-2.5 py-1 rounded-full glass-subtle text-muted-foreground hover:text-foreground hover:bg-accent transition-colors font-medium"
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
                    onClick={handleGenerateMore}
                    disabled={extraLoading}
                    className="text-[11px] px-2.5 py-1 rounded-full border border-dashed border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors font-medium disabled:opacity-50 inline-flex items-center gap-1"
                    title={
                      visiblePrompts.length === 0
                        ? "Generate paper-specific question suggestions"
                        : "Add more paper-specific suggestions"
                    }
                  >
                    {extraLoading ? (
                      <>
                        <span className="inline-block w-2.5 h-2.5 border-[1.5px] border-current border-t-transparent rounded-full animate-spin" />
                        Thinking…
                      </>
                    ) : (
                      <>
                        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                        </svg>
                        {visiblePrompts.length === 0 ? "Suggest questions" : "More like these"}
                      </>
                    )}
                  </button>
                )}
              </div>
            )}
            {extraError && (
              <p role="alert" className="text-[10.5px] text-destructive/80 leading-snug">
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
          className="text-[13px] resize-none"
        />
        <div className="flex gap-2">
          <button
            onClick={handleAdd}
            className={`flex-1 text-[12px] font-medium py-1.5 rounded-lg border transition-all ${
              justAdded
                ? "border-green-300 bg-green-50 text-green-700"
                : "border-border hover:bg-accent"
            }`}
          >
            {justAdded ? "✓ Added" : "Add Question"}
          </button>
          <button
            onClick={handleAnswerAll}
            disabled={questions.length === 0 || qaLoading}
            className="flex-1 text-[12px] font-medium py-1.5 rounded-xl btn-primary-glass text-background transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {qaLoading ? "Answering..." : `Answer All (${questions.length})`}
          </button>
        </div>
      </div>

      {qaLoading && (
        <div className="flex flex-col items-center gap-2 py-4">
          <ProgressBar />
          <p className="text-[11px] text-muted-foreground animate-pulse">
            {crossPaper && hasMultiplePapers ? "Analyzing across papers..." : "Analyzing..."}
          </p>
        </div>
      )}

      {qaError && (
        <div role="alert" className="rounded-lg bg-destructive/10 border border-destructive/20 px-3.5 py-2.5 space-y-1">
          <p className="text-[12px] text-destructive font-medium">
            {qaErrorKind === "limit" ? "Limit reached" : "Couldn't answer"}
          </p>
          <p className="text-[11px] text-destructive">{qaError}</p>
        </div>
      )}

      {questions.length > 0 && !qaLoading && (
        <div className="space-y-2">
          <div className="flex items-baseline gap-2">
            <h3 className="text-[13px] font-semibold text-foreground">Queued</h3>
            <span className="text-[11px] text-muted-foreground/60 tabular-nums">{questions.length}</span>
          </div>
          {questions.map((q, i) => (
            <div key={i} className="flex items-start gap-2.5 rounded-xl glass-subtle px-3.5 py-2">
              <span className="text-[11px] text-muted-foreground/50 font-medium shrink-0 mt-0.5 tabular-nums">
                {i + 1}.
              </span>
              <p className="text-[13px] flex-1">{q}</p>
              <button
                onClick={() => removeQuestion(i)}
                className="text-muted-foreground/40 hover:text-destructive shrink-0 mt-0.5 transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {qaResults.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-baseline gap-2">
              <h3 className="text-[13px] font-semibold text-foreground">Answers</h3>
              <span className="text-[11px] text-muted-foreground/60 tabular-nums">{qaResults.length}</span>
              {crossPaper && hasMultiplePapers && (
                <span className="text-[10px] text-muted-foreground/50">cross-paper</span>
              )}
            </div>
            <button
              onClick={() => { setQAResults([]); clearQuestions(); setUsedPrompts(new Set()); setQAError(""); }}
              className="text-[11px] text-muted-foreground/50 hover:text-muted-foreground transition-colors font-medium"
            >
              Clear
            </button>
          </div>
          {/*
            Newest answer first. Numeric ordinals were dropped at the user's
            request — the visual order now carries the "which is newest"
            affordance, and chronological numbers were misleading after the
            list was inverted anyway.
          */}
          {[...qaResults].reverse().map((item, i) => (
            <div key={qaResults.length - 1 - i} className="space-y-1.5">
              <div className="flex items-start gap-2 px-1">
                <p className="text-[13px] font-semibold leading-snug">{item.question}</p>
              </div>
              <div className="rounded-xl glass-subtle px-3.5 py-2.5 border-l-2 border-foreground/10">
                <div className="text-[12px] text-muted-foreground"><Md>{item.answer}</Md></div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
