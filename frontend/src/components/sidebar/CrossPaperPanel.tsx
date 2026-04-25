"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { Md } from "@/components/ui/Md";
import { Textarea } from "@/components/ui/textarea";
import { AnalysisProgress } from "@/components/ui/AnalysisProgress";
import { SectionHeader } from "@/components/panel/SectionHeader";

const PROMPTS = [
  "Compare the methodologies",
  "What are the common assumptions?",
  "How do the results complement each other?",
  "Identify contradictions between these papers",
  "Synthesize the key findings",
  "Which paper has stronger evidence?",
];

export function CrossPaperPanel() {
  const { sessionPapers, crossPaperResults, addCrossPaperResults, clearCrossPaperResults } = useStore();
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const paperIds = sessionPapers.map((p) => p.id);

  const handleAsk = async (question?: string) => {
    const q = (question || input).trim();
    if (!q || paperIds.length < 2) return;
    if (!question) setInput("");
    setError("");
    setLoading(true);
    try {
      const res = await api.askQuestionsMulti(paperIds, [q]);
      const answers = res.items.map((item: { question: string; answer: string }) => ({
        question: item.question,
        answer: item.answer,
      }));
      addCrossPaperResults(answers);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to analyze");
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleAsk(); }
  };

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-2 flex items-center gap-2">
          <svg className="h-4 w-4 text-muted-foreground/80" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden>
            <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
          </svg>
          <h2 className="text-[var(--text-md)] font-semibold tracking-tight text-foreground">
            Cross-paper analysis
          </h2>
        </div>
        <p className="mb-3 text-[var(--text-sm)] text-muted-foreground">
          Ask questions that span all {sessionPapers.length} papers in this session.
        </p>
        <div className="mb-3 flex flex-wrap gap-1.5 px-0.5">
          {sessionPapers.map((p) => (
            <span
              key={p.id}
              className="max-w-[200px] truncate rounded-md border border-border/60 bg-transparent px-2 py-1 text-[var(--text-xs)] text-muted-foreground"
            >
              {p.title.length > 30 ? p.title.slice(0, 30) + "…" : p.title}
            </span>
          ))}
        </div>
      </div>

      {crossPaperResults.length === 0 && !loading && (
        <div className="flex flex-wrap gap-1.5">
          {PROMPTS.map((prompt) => (
            <button
              key={prompt}
              type="button"
              onClick={() => handleAsk(prompt)}
              className="rounded-md border border-border/60 bg-transparent px-2.5 py-1 text-left text-[var(--text-xs)] font-medium text-muted-foreground transition-colors motion-safe:duration-150 hover:border-border hover:bg-accent/40 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {prompt}
            </button>
          ))}
        </div>
      )}

      <div className="space-y-2">
        <Textarea
          placeholder="Ask a question across all papers…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={2}
          className="text-[var(--text-md)] resize-none"
        />
        <button
          type="button"
          onClick={() => void handleAsk()}
          disabled={!input.trim() || loading}
          className="btn-primary-glass h-10 w-full rounded-lg text-[var(--text-sm)] font-medium text-background transition-opacity focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40"
        >
          {loading ? "Analyzing across papers…" : "Ask"}
        </button>
      </div>

      {loading && (
        <div className="flex min-h-[16vh] flex-col items-center justify-center gap-3 py-4">
          <div className="w-full max-w-xs">
            <AnalysisProgress kind="qa" />
          </div>
          <p className="text-[var(--text-sm)] text-muted-foreground">Comparing papers…</p>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-destructive/20 bg-destructive/10 px-3.5 py-2.5">
          <p className="text-[var(--text-sm)] font-medium text-destructive">Error</p>
          <p className="mt-0.5 text-[var(--text-xs)] text-destructive/90">{error}</p>
        </div>
      )}

      {crossPaperResults.length > 0 && (
        <div className="space-y-3">
          <SectionHeader
            title="Results"
            count={crossPaperResults.length}
            action={
              <button
                type="button"
                onClick={clearCrossPaperResults}
                className="text-[var(--text-xs)] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                Clear
              </button>
            }
          />
          {crossPaperResults.map((r, i) => (
            <div
              key={i}
              className="space-y-2 rounded-lg border border-border/60 bg-card/30 px-4 py-3"
            >
              <p className="text-[var(--text-md)] font-medium text-foreground">{r.question}</p>
              <div className="text-[var(--text-sm)] text-muted-foreground">
                <Md>{r.answer}</Md>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
