"use client";

import { useState } from "react";
import { api, ExplainResponse } from "@/lib/api";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

interface DefinitionPopoverProps {
  paperId: string;
  term: string;
  context: string;
  onClose: () => void;
  position: { x: number; y: number };
}

export function DefinitionPopover({
  paperId,
  term,
  context,
  onClose,
  position,
}: DefinitionPopoverProps) {
  const [result, setResult] = useState<ExplainResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetched, setFetched] = useState(false);

  const handleFetch = async () => {
    setLoading(true);
    try {
      const res = await api.explain(paperId, term, context);
      setResult(res);
      setFetched(true);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed z-50 animate-fade-in" style={{ left: position.x, top: position.y }}>
      <div className="w-80 bg-card border rounded-xl shadow-lg p-4 space-y-2.5">
        <div className="flex items-center justify-between">
          <p className="font-semibold text-[13px]">{term}</p>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors w-5 h-5 flex items-center justify-center rounded-md hover:bg-muted"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {!fetched && !loading && (
          <button
            onClick={handleFetch}
            className="w-full text-[13px] font-medium py-1.5 rounded-lg bg-foreground text-background hover:opacity-90 transition-opacity"
          >
            Look up
          </button>
        )}

        {loading && (
          <div className="flex items-center gap-2 py-1">
            <div className="w-3.5 h-3.5 border-2 border-muted-foreground/30 border-t-foreground rounded-full animate-spin" />
            <span className="text-[12px] text-muted-foreground">Looking up...</span>
          </div>
        )}

        {result && (
          <div className="space-y-1.5">
            <div className="text-[12px] leading-relaxed analysis-content">
              <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
                {result.explanation}
              </ReactMarkdown>
            </div>
            {result.source && (
              <p className="text-[11px] text-muted-foreground/70">
                Source: {result.source}
              </p>
            )}
            {result.in_paper && (
              <p className="text-[11px] text-muted-foreground/70 italic">
                Defined in this paper
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
