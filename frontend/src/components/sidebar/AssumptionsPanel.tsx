"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { Md } from "@/components/ui/Md";
import { getProgressStart, clearProgressStart, markRequestStart, markRequestEnd } from "@/lib/analysisState";

interface AssumptionsPanelProps {
  paperId: string;
}

function ProgressBar({ paperId }: { paperId: string }) {
  const [width, setWidth] = useState(() => {
    const start = getProgressStart(paperId, "assumptions");
    const elapsed = (Date.now() - start) / 1000;
    return Math.min(90, 90 * (1 - Math.exp(-elapsed / 10)));
  });
  useEffect(() => {
    const start = getProgressStart(paperId, "assumptions");
    const interval = setInterval(() => {
      const elapsed = (Date.now() - start) / 1000;
      setWidth(Math.min(90, 90 * (1 - Math.exp(-elapsed / 10))));
    }, 150);
    return () => clearInterval(interval);
  }, [paperId]);
  return (
    <div className="w-full max-w-xs h-1 bg-accent rounded-full overflow-hidden">
      <div className="h-full bg-foreground/60 rounded-full transition-all duration-200 ease-out" style={{ width: `${width}%` }} />
    </div>
  );
}

export function AssumptionsPanel({ paperId }: AssumptionsPanelProps) {
  const { assumptions, setAssumptions, assumptionsLoading, setAssumptionsLoading } = useStore();
  const currentPaperRef = useRef(paperId);
  currentPaperRef.current = paperId;
  const [error, setError] = useState<string | null>(null);

  // Reset the local error whenever we switch to a different paper — the
  // previous paper's failure banner should not bleed into the new one.
  useEffect(() => { setError(null); }, [paperId]);

  const handleExtract = async () => {
    const targetId = paperId;
    setError(null);
    clearProgressStart(targetId, "assumptions");
    markRequestStart(targetId, "assumptions");
    setAssumptionsLoading(true);
    try {
      const result = await api.getAssumptions(targetId);
      if (currentPaperRef.current === targetId) {
        setAssumptions(result.assumptions);
        if (result.assumptions.length === 0) {
          // Defensive: if the backend ever relaxes its "no items = 502"
          // rule, still surface a clear message instead of dropping the
          // user back onto a silent "Extract" button.
          setError("The model didn't find any explicit or implicit assumptions in this paper.");
        }
      }
    } catch (e) {
      console.error("Assumptions extraction failed:", e);
      if (currentPaperRef.current === targetId) {
        setError(e instanceof Error ? e.message : "Extraction failed. Please try again.");
      }
    } finally {
      markRequestEnd(targetId, "assumptions");
      clearProgressStart(targetId, "assumptions");
      if (currentPaperRef.current === targetId) {
        setAssumptionsLoading(false);
      }
    }
  };

  if (assumptionsLoading) {
    return (
      <div className="flex flex-col items-center gap-3 py-8 justify-center animate-fade-in">
        <ProgressBar paperId={paperId} />
        <p className="text-[13px] text-muted-foreground">Extracting assumptions…</p>
      </div>
    );
  }

  if (assumptions.length === 0) {
    return (
      <div className="py-8 text-center space-y-3 animate-fade-in">
        <p className="text-[14px] text-muted-foreground">
          {error
            ? "Assumption extraction didn't return any results."
            : "Identify explicit and implicit assumptions in this paper."}
        </p>
        {error && (
          <p className="text-[12px] text-destructive/80 max-w-sm mx-auto">{error}</p>
        )}
        <button
          onClick={handleExtract}
          className="text-[13px] font-medium bg-foreground text-background px-5 py-1.5 rounded-lg hover:opacity-90 transition-opacity"
        >
          {error ? "Try again" : "Extract Assumptions"}
        </button>
      </div>
    );
  }

  const explicit = assumptions.filter((a) => a.type === "explicit");
  const implicit = assumptions.filter((a) => a.type === "implicit");

  return (
    <div className="space-y-5 animate-fade-in">
      {explicit.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-baseline gap-2">
            <h3 className="text-[13px] font-semibold text-foreground">Explicit</h3>
            <span className="text-[11px] text-muted-foreground/60 tabular-nums">{explicit.length}</span>
          </div>
          <div className="space-y-1.5">
            {explicit.map((a, i) => (
              <div key={i} className="rounded-xl glass-subtle px-3.5 py-2.5">
                <div className="text-[13px] leading-relaxed"><Md>{a.statement}</Md></div>
                {a.section && (
                  <span className="inline-block mt-1.5 text-[10px] text-muted-foreground/60 bg-muted px-2 py-0.5 rounded-full font-medium">
                    {a.section}
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {implicit.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-baseline gap-2">
            <h3 className="text-[13px] font-semibold text-foreground">Implicit</h3>
            <span className="text-[11px] text-muted-foreground/60 tabular-nums">{implicit.length}</span>
          </div>
          <div className="space-y-1.5">
            {implicit.map((a, i) => (
              <div key={i} className="rounded-xl glass-subtle border border-dashed border-border px-3.5 py-2.5">
                <div className="text-[13px] leading-relaxed"><Md>{a.statement}</Md></div>
                {a.section && (
                  <span className="inline-block mt-1.5 text-[10px] text-muted-foreground/60 bg-muted px-2 py-0.5 rounded-full font-medium">
                    {a.section}
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="pt-1">
        <button
          onClick={handleExtract}
          className="text-[11px] font-medium text-muted-foreground/60 hover:text-foreground transition-colors"
        >
          Re-extract
        </button>
      </div>
    </div>
  );
}
