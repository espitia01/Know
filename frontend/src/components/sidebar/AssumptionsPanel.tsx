"use client";

import { useState, useEffect } from "react";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { Md } from "@/components/ui/Md";

interface AssumptionsPanelProps {
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
    <div className="w-full max-w-xs h-1 bg-accent rounded-full overflow-hidden">
      <div className="h-full bg-foreground/60 rounded-full transition-all duration-200 ease-out" style={{ width: `${width}%` }} />
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
      <div className="flex flex-col items-center gap-3 py-8 justify-center animate-fade-in">
        <ProgressBar />
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
