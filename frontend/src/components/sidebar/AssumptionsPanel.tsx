"use client";

import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

interface AssumptionsPanelProps {
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

export function AssumptionsPanel({ paperId }: AssumptionsPanelProps) {
  const { assumptions, setAssumptions, assumptionsLoading, setAssumptionsLoading } = useStore();

  const handleExtract = async () => {
    setAssumptionsLoading(true);
    try {
      const result = await api.getAssumptions(paperId);
      setAssumptions(result.assumptions);
    } catch (e) {
      console.error("Assumptions extraction failed:", e);
    } finally {
      setAssumptionsLoading(false);
    }
  };

  if (assumptionsLoading) {
    return (
      <div className="flex items-center gap-3 py-8 justify-center animate-fade-in">
        <div className="w-4 h-4 border-2 border-muted-foreground/30 border-t-foreground rounded-full animate-spin" />
        <p className="text-[13px] text-muted-foreground">Extracting assumptions...</p>
      </div>
    );
  }

  if (assumptions.length === 0) {
    return (
      <div className="py-8 text-center space-y-3 animate-fade-in">
        <p className="text-[14px] text-muted-foreground">
          Identify explicit and implicit assumptions in this paper.
        </p>
        <button
          onClick={handleExtract}
          className="text-[13px] font-medium bg-foreground text-background px-5 py-1.5 rounded-lg hover:opacity-90 transition-opacity"
        >
          Extract Assumptions
        </button>
      </div>
    );
  }

  const explicit = assumptions.filter((a) => a.type === "explicit");
  const implicit = assumptions.filter((a) => a.type === "implicit");

  return (
    <div className="space-y-4 animate-fade-in">
      {explicit.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[12px] font-semibold text-muted-foreground/70 uppercase tracking-widest">
            Explicit <span className="text-muted-foreground/40">{explicit.length}</span>
          </p>
          {explicit.map((a, i) => (
            <div key={i} className="rounded-lg bg-accent/50 px-3.5 py-2.5">
              <div className="text-[13px]"><Md>{a.statement}</Md></div>
              {a.section && (
                <span className="inline-block mt-1.5 text-[10px] text-muted-foreground/60 bg-muted px-2 py-0.5 rounded-full font-medium">
                  {a.section}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {implicit.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[12px] font-semibold text-muted-foreground/70 uppercase tracking-widest">
            Implicit <span className="text-muted-foreground/40">{implicit.length}</span>
          </p>
          {implicit.map((a, i) => (
            <div key={i} className="rounded-lg bg-accent/30 border border-dashed border-border/60 px-3.5 py-2.5">
              <div className="text-[13px]"><Md>{a.statement}</Md></div>
              {a.section && (
                <span className="inline-block mt-1.5 text-[10px] text-muted-foreground/60 bg-muted px-2 py-0.5 rounded-full font-medium">
                  {a.section}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      <button
        onClick={handleExtract}
        className="text-[12px] text-muted-foreground/60 hover:text-muted-foreground transition-colors font-medium"
      >
        Re-extract
      </button>
    </div>
  );
}
