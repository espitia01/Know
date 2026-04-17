"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { Textarea } from "@/components/ui/textarea";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

interface QAPanelProps {
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

const GUIDED_PROMPTS = [
  "What is the main contribution?",
  "Key limitations?",
  "How does this compare to prior work?",
  "What experiments support the claims?",
  "Practical implications?",
];

export function QAPanel({ paperId }: QAPanelProps) {
  const { questions, addQuestion, removeQuestion, clearQuestions, qaResults, setQAResults, qaLoading, setQALoading } = useStore();
  const [input, setInput] = useState("");

  const handleAdd = () => {
    const q = input.trim();
    if (q) { addQuestion(q); setInput(""); }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleAdd(); }
  };

  const handleAnswerAll = async () => {
    if (questions.length === 0) return;
    setQALoading(true);
    try {
      const result = await api.askQuestions(paperId, questions);
      setQAResults(result.items);
    } catch (e) {
      console.error("Q&A failed:", e);
    } finally {
      setQALoading(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2.5">
        <p className="text-[13px] text-muted-foreground">
          Queue questions as you read, then answer them all at once.
        </p>

        {questions.length === 0 && qaResults.length === 0 && (
          <div className="flex flex-wrap gap-1.5">
            {GUIDED_PROMPTS.map((prompt, i) => (
              <button
                key={i}
                onClick={() => addQuestion(prompt)}
                className="text-[11px] px-2.5 py-1 rounded-full bg-accent/60 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors font-medium"
              >
                {prompt}
              </button>
            ))}
          </div>
        )}

        <Textarea
          placeholder="Type a question..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={2}
          className="text-[13px] resize-none"
        />
        <div className="flex gap-2">
          <button
            onClick={handleAdd}
            className="flex-1 text-[12px] font-medium py-1.5 rounded-lg border border-border hover:bg-accent transition-colors"
          >
            Add Question
          </button>
          <button
            onClick={handleAnswerAll}
            disabled={questions.length === 0 || qaLoading}
            className="flex-1 text-[12px] font-medium py-1.5 rounded-lg bg-foreground text-background hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {qaLoading ? "Answering..." : `Answer All (${questions.length})`}
          </button>
        </div>
      </div>

      {questions.length > 0 && qaResults.length === 0 && (
        <div className="space-y-1.5">
          <p className="text-[12px] font-semibold text-muted-foreground/70 uppercase tracking-widest">
            Questions <span className="text-muted-foreground/40">{questions.length}</span>
          </p>
          {questions.map((q, i) => (
            <div key={i} className="flex items-start gap-2.5 rounded-lg bg-accent/50 px-3.5 py-2">
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
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[12px] font-semibold text-muted-foreground/70 uppercase tracking-widest">
              Answers
            </p>
            <button
              onClick={() => { setQAResults([]); clearQuestions(); }}
              className="text-[11px] text-muted-foreground/50 hover:text-muted-foreground transition-colors font-medium"
            >
              Clear
            </button>
          </div>
          {qaResults.map((item, i) => (
            <div key={i} className="rounded-lg bg-accent/50 px-3.5 py-2.5 space-y-1">
              <p className="text-[13px] font-medium">{item.question}</p>
              <div className="text-[12px] text-muted-foreground"><Md>{item.answer}</Md></div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
