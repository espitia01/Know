"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { Md } from "@/components/ui/Md";
import { Textarea } from "@/components/ui/textarea";

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
        <div className="flex items-center gap-2 mb-2">
          <svg className="w-4 h-4 text-muted-foreground/80" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
          </svg>
          <p className="text-[var(--text-md)] font-semibold text-foreground">Cross-Paper Analysis</p>
        </div>
        <p className="text-[var(--text-sm)] text-muted-foreground mb-3">
          Ask questions that span all {sessionPapers.length} papers in this session.
        </p>
        <div className="flex flex-wrap gap-1.5 mb-3 px-1">
          {sessionPapers.map((p) => (
            <span key={p.id} className="text-[var(--text-xs)] px-2 py-1 rounded-full glass-subtle text-muted-foreground truncate max-w-[200px]">
              {p.title.length > 30 ? p.title.slice(0, 30) + "..." : p.title}
            </span>
          ))}
        </div>
      </div>

      {crossPaperResults.length === 0 && !loading && (
        <div className="flex flex-wrap gap-1.5">
          {PROMPTS.map((prompt) => (
            <button
              key={prompt}
              onClick={() => handleAsk(prompt)}
              className="text-[var(--text-xs)] px-2.5 py-1.5 rounded-xl glass-subtle text-muted-foreground hover:text-foreground hover:bg-accent transition-all font-medium"
            >
              {prompt}
            </button>
          ))}
        </div>
      )}

      <div className="space-y-2">
        <Textarea
          placeholder="Ask a question across all papers..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={2}
          className="text-[var(--text-md)] resize-none"
        />
        <button
          onClick={() => handleAsk()}
          disabled={!input.trim() || loading}
          className="w-full text-[var(--text-sm)] font-semibold py-2.5 rounded-xl btn-primary-glass text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {loading ? "Analyzing across papers..." : "Ask"}
        </button>
      </div>

      {loading && (
        <div className="flex items-center justify-center gap-2 py-4">
          <div className="w-4 h-4 border-2 border-border border-t-foreground rounded-full animate-spin" />
          <p className="text-[var(--text-sm)] text-muted-foreground">Comparing papers...</p>
        </div>
      )}

      {error && (
        <div className="rounded-lg bg-destructive/10 border border-destructive/20 px-3.5 py-2.5">
          <p className="text-[var(--text-sm)] text-destructive font-medium">Error</p>
          <p className="text-[var(--text-xs)] text-destructive mt-0.5">{error}</p>
        </div>
      )}

      {crossPaperResults.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-[var(--text-xs)] font-bold uppercase tracking-[0.15em] text-muted-foreground">
              Results
            </p>
            <button
              onClick={clearCrossPaperResults}
              className="text-[var(--text-xs)] text-muted-foreground hover:text-foreground/90 transition-colors font-medium"
            >
              Clear
            </button>
          </div>
          {crossPaperResults.map((r, i) => (
            <div key={i} className="rounded-2xl glass px-4 py-3 space-y-2">
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
