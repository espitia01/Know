"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { Md } from "@/components/ui/Md";
import { clearProgressStart, markRequestStart, markRequestEnd } from "@/lib/analysisState";
import { AnalysisProgress } from "@/components/ui/AnalysisProgress";
import { EmptyState } from "@/components/ui/EmptyState";

interface AssumptionsPanelProps {
  paperId: string;
}

export function AssumptionsPanel({ paperId }: AssumptionsPanelProps) {
  const { assumptions, setAssumptions, assumptionsLoading, setAssumptionsLoading, paper } = useStore();
  const currentPaperRef = useRef(paperId);
  currentPaperRef.current = paperId;
  const [error, setError] = useState<string | null>(null);
  const cooldownUntil = Number(paper?.id === paperId ? paper.cached_analysis?.assumptions_cooldown_until || 0 : 0);
  const coolingDown = cooldownUntil > Date.now() / 1000;

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
        <AnalysisProgress kind="assumptions" paperId={paperId} />
        <p className="text-[var(--text-md)] text-muted-foreground">Extracting assumptions…</p>
      </div>
    );
  }

  if (assumptions.length === 0) {
    return (
      <EmptyState
        title={coolingDown ? "Assumptions need a short pause" : error ? "Assumption extraction did not return results" : "Extract assumptions"}
        body={coolingDown ? "The model did not find usable assumptions on the last attempt. Try again in a few minutes." : error || "Identify explicit and implicit assumptions in this paper."}
        cta={coolingDown ? undefined : { label: error ? "Try again" : "Extract Assumptions", onClick: handleExtract }}
      />
    );
  }

  const explicit = assumptions.filter((a) => a.type === "explicit");
  const implicit = assumptions.filter((a) => a.type === "implicit");

  return (
    <div className="space-y-6 animate-fade-in">
      {explicit.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-baseline gap-2">
            <h3 className="text-[var(--text-md)] font-semibold text-foreground">Explicit</h3>
            <span className="text-[var(--text-xs)] text-muted-foreground/60 tabular-nums">{explicit.length}</span>
          </div>
          <div className="space-y-2">
            {explicit.map((a, i) => (
              <div key={i} className="rounded-xl glass-subtle px-3.5 py-2.5">
                <div className="text-[var(--text-md)] leading-relaxed"><Md>{a.statement}</Md></div>
                {a.section && (
                  <span className="inline-block mt-1.5 text-[var(--text-xs)] text-muted-foreground/60 bg-muted px-2 py-0.5 rounded-full font-medium">
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
            <h3 className="text-[var(--text-md)] font-semibold text-foreground">Implicit</h3>
            <span className="text-[var(--text-xs)] text-muted-foreground/60 tabular-nums">{implicit.length}</span>
          </div>
          <div className="space-y-2">
            {implicit.map((a, i) => (
              <div key={i} className="rounded-xl glass-subtle border border-dashed border-border px-3.5 py-2.5">
                <div className="text-[var(--text-md)] leading-relaxed"><Md>{a.statement}</Md></div>
                {a.section && (
                  <span className="inline-block mt-1.5 text-[var(--text-xs)] text-muted-foreground/60 bg-muted px-2 py-0.5 rounded-full font-medium">
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
          className="text-[var(--text-xs)] font-medium text-muted-foreground/60 hover:text-foreground transition-colors"
        >
          Re-extract
        </button>
      </div>
    </div>
  );
}
