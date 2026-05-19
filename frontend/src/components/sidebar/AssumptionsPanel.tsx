"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { StreamingMarkdown } from "@/components/analysis/StreamingMarkdown";
import { Badge } from "@/components/ui/badge";
import {
  autoAnalyzedPapers,
  clearProgressStart,
  hasActiveRequest,
  markRequestEnd,
  markRequestStart,
} from "@/lib/analysisState";
import { useUserTier, canAccess } from "@/lib/UserTierContext";
import { AnalysisProgress } from "@/components/ui/AnalysisProgress";
import { EmptyState } from "@/components/ui/EmptyState";
import { AnalysisSection } from "@/components/analysis/AnalysisSection";

interface AssumptionsPanelProps {
  paperId: string;
}

const rowListClass =
  "overflow-hidden rounded-lg border border-border/50 bg-card/35 dark:bg-card/22";

const rowItemClass =
  "border-b border-border/60 px-4 py-3 last:border-b-0 motion-safe:transition-colors motion-safe:duration-150 motion-safe:ease-out hover:bg-accent/40";

/** Strip redundant type labels often echoed by the model now that tabs split explicit vs implicit. */
function assumptionStatementDisplay(statement: string, type: string): string {
  let t = statement.trim();
  /* Model sometimes emits `\dot Implicit` / `\. Implicit` scraps before prose. */
  t = t.replace(/\\dot\s*\{?\s*Implicit\s*\}?\.?/gi, "").trim();
  t = t.replace(/\\dot\s*\{?\s*Explicit\s*\}?\.?/gi, "").trim();
  t = t.replace(/\\\.\s*[Ii]mplicit\b[\s.:)]*/gi, "").trim();
  t = t.replace(/\\\.\s*[Ee]xplicit\b[\s.:)]*/gi, "").trim();
  t = t.replace(/^[\s.,;:]*[Ii]mplicit\b\.?\s*[:.)-]?\s*/i, "").trim();
  t = t.replace(/^[\s.,;:]*[Ee]xplicit\b\.?\s*[:.)-]?\s*/i, "").trim();
  t = t.replace(/^(explicit|implicit)\s*assumption\s*:\s*/i, "").trim();
  t = t.replace(/^(explicit|implicit)\s*:\s*/i, "").trim();
  if (type === "implicit") {
    t = t.replace(/^implicit\s+/i, "").trim();
  } else if (type === "explicit") {
    t = t.replace(/^explicit\s+/i, "").trim();
  }
  return t;
}

export function AssumptionsPanel({ paperId }: AssumptionsPanelProps) {
  const { assumptions, setAssumptions, assumptionsLoading, setAssumptionsLoading, paper } = useStore();
  const { user: tierUser } = useUserTier();
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

  useEffect(() => {
    const pid = paperId;
    const cooldown =
      (paper?.id === pid ? Number(paper.cached_analysis?.assumptions_cooldown_until || 0) : 0) >
      Date.now() / 1000;
    if (
      assumptions.length === 0 &&
      !cooldown &&
      !assumptionsLoading &&
      !hasActiveRequest(pid, "assumptions") &&
      !autoAnalyzedPapers.has(`${pid}:assumptions`) &&
      canAccess(tierUser?.tier || "free", "assumptions")
    ) {
      void handleExtract();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount safety net per paper
  }, [paperId]);

  if (assumptionsLoading) {
    return (
      <div className="flex flex-col items-center gap-2 py-6 motion-safe:animate-fade-in">
        <div className="w-full max-w-[16rem]">
          <AnalysisProgress kind="assumptions" paperId={paperId} />
        </div>
        <p className="text-[var(--text-xs)] text-muted-foreground/85">Extracting assumptions…</p>
      </div>
    );
  }

  if (assumptions.length === 0) {
    return (
      <EmptyState
        title={coolingDown ? "Assumptions need a short pause" : error ? "Assumption extraction did not return results" : "Extract assumptions"}
        body={coolingDown ? "The model did not find usable assumptions on the last attempt. Try again in a few minutes." : error || "Identify explicit and implicit assumptions in this paper."}
        cta={coolingDown ? undefined : { label: error ? "Try again" : "Extract Assumptions", onClick: handleExtract }}
        secondaryAction={
          !coolingDown
            ? {
                label: "Why didn't this work?",
                onClick: () => {
                  window.alert(
                    "The model may miss assumptions in non-standard writing, very short sections, or when claims are only implied. Try again after a few minutes, or re-run after more of the paper has been processed.",
                  );
                },
              }
            : undefined
        }
      />
    );
  }

  const explicit = assumptions.filter((a) => a.type === "explicit");
  const implicit = assumptions.filter((a) => a.type === "implicit");

  return (
    <div className="space-y-6 motion-safe:animate-fade-in">
      {explicit.length > 0 && (
        <AnalysisSection title="Explicit" count={explicit.length} size="nested">
          <div className={rowListClass}>
            {explicit.map((a, i) => (
              <div key={i} className={rowItemClass}>
                <StreamingMarkdown>
                  {assumptionStatementDisplay(a.statement, a.type)}
                </StreamingMarkdown>
                {a.section && (
                  <Badge variant="soft" className="mt-2">
                    {a.section}
                  </Badge>
                )}
              </div>
            ))}
          </div>
        </AnalysisSection>
      )}

      {implicit.length > 0 && (
        <AnalysisSection title="Implicit" count={implicit.length} size="nested">
          <div className={rowListClass}>
            {implicit.map((a, i) => (
              <div key={i} className={rowItemClass}>
                <StreamingMarkdown>
                  {assumptionStatementDisplay(a.statement, a.type)}
                </StreamingMarkdown>
                {a.section && (
                  <Badge variant="soft" className="mt-2">
                    {a.section}
                  </Badge>
                )}
              </div>
            ))}
          </div>
        </AnalysisSection>
      )}

      <div className="pt-1">
        <button
          type="button"
          onClick={handleExtract}
          className="text-[var(--text-xs)] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          Re-extract
        </button>
      </div>
    </div>
  );
}
