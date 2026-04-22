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

const GUIDED_PROMPTS = [
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
  } = useStore();
  const { user } = useUserTier();
  const tier = user?.tier || "free";
  const [input, setInput] = useState("");
  const [crossPaper, setCrossPaper] = useState(false);
  const [qaError, setQAError] = useState("");
  const [usedPrompts, setUsedPrompts] = useState<Set<string>>(new Set());

  const canMultiQA = canAccess(tier, "multi-qa");
  const hasMultiplePapers = sessionPapers.length > 1 && canMultiQA;

  const [justAdded, setJustAdded] = useState(false);
  const justAddedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (justAddedTimerRef.current) clearTimeout(justAddedTimerRef.current);
    };
  }, []);

  // Keep the draft question for this paper so a refresh or accidental
  // navigation doesn't lose what the user was in the middle of typing.
  // Scoped per paper so switching between papers doesn't blend drafts.
  const draftKey = `know-qa-draft:${paperId}`;
  useEffect(() => {
    try {
      const saved = localStorage.getItem(draftKey);
      if (saved) setInput(saved);
    } catch { /* ignore */ }
    // Only restore on mount or paper switch — deliberate empty dep on
    // setInput since the setter is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperId]);

  useEffect(() => {
    try {
      if (input.trim()) {
        localStorage.setItem(draftKey, input);
      } else {
        localStorage.removeItem(draftKey);
      }
    } catch { /* ignore */ }
  }, [input, draftKey]);

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

  const prompts = crossPaper && hasMultiplePapers ? CROSS_PAPER_PROMPTS : GUIDED_PROMPTS;

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
          <div className="flex flex-wrap gap-1.5">
            {prompts.filter((p) => !usedPrompts.has(p)).map((prompt, i) => (
              <button
                key={i}
                onClick={() => {
                  addQuestion(prompt);
                  setUsedPrompts((prev) => new Set(prev).add(prompt));
                }}
                className="text-[11px] px-2.5 py-1 rounded-full glass-subtle text-muted-foreground hover:text-foreground hover:bg-accent transition-colors font-medium"
              >
                {prompt}
              </button>
            ))}
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
        <div className="space-y-1.5">
          <p className="text-[12px] font-semibold text-muted-foreground/70 uppercase tracking-widest">
            Queued <span className="text-muted-foreground/40">{questions.length}</span>
          </p>
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
            <p className="text-[12px] font-semibold text-muted-foreground/70 uppercase tracking-widest">
              Answers
              {crossPaper && hasMultiplePapers && (
                <span className="ml-1.5 text-[10px] text-muted-foreground/40 normal-case tracking-normal font-normal">
                  (cross-paper)
                </span>
              )}
            </p>
            <button
              onClick={() => { setQAResults([]); clearQuestions(); setUsedPrompts(new Set()); setQAError(""); }}
              className="text-[11px] text-muted-foreground/50 hover:text-muted-foreground transition-colors font-medium"
            >
              Clear
            </button>
          </div>
          {qaResults.map((item, i) => (
            <div key={i} className="space-y-1.5">
              <div className="flex items-start gap-2 px-1">
                <span className="text-[11px] font-bold text-muted-foreground/40 shrink-0 mt-0.5 tabular-nums">{i + 1}.</span>
                <p className="text-[13px] font-semibold leading-snug">{item.question}</p>
              </div>
              <div className="rounded-xl glass-subtle px-3.5 py-2.5 ml-4 border-l-2 border-foreground/10">
                <div className="text-[12px] text-muted-foreground"><Md>{item.answer}</Md></div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
