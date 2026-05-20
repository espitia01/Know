"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useStore, EMPTY_ASSUMPTIONS_LIST } from "@/lib/store";
import { StreamingMarkdown } from "@/components/analysis/StreamingMarkdown";
import { Badge } from "@/components/ui/badge";
import {
  autoAnalyzedPapers,
  clearProgressStart,
  getCachedAssumptionItems,
  hasActiveRequest,
  markAssumptionsAttemptFailed,
  markRequestEnd,
  markRequestStart,
  assumptionsCooldownActive,
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
  const assumptions = useStore(
    (s) => s.assumptionsByPaper[paperId] ?? EMPTY_ASSUMPTIONS_LIST,
  );
  const setAssumptionsForPaper = useStore((s) => s.setAssumptionsForPaper);
  const assumptionsLoading = useStore(
    (s) => s.assumptionsLoadingByPaper[paperId] ?? false,
  );
  const setAssumptionsLoadingForPaper = useStore(
    (s) => s.setAssumptionsLoadingForPaper,
  );
  const setAssumptionsError = useStore((s) => s.setAssumptionsError);
  const autoError = useStore((s) => s.assumptionsErrorByPaper[paperId] ?? null);
  const paper = useStore((s) => s.paper);
  const updateCachedAnalysis = useStore((s) => s.updateCachedAnalysis);
  const { user: tierUser } = useUserTier();
  const currentPaperRef = useRef(paperId);
  currentPaperRef.current = paperId;
  const [manualError, setManualError] = useState<string | null>(null);
  const sessionCache = useStore((s) => s.papersById[paperId]?.cached_analysis);
  const paperCache = paper?.id === paperId ? paper.cached_analysis : undefined;
  const coolingDown = assumptionsCooldownActive(paperCache, sessionCache);
  const displayError = manualError ?? autoError;

  // Reset manual retry errors when switching papers — auto-analyze errors
  // live in the store and are keyed per paper.
  useEffect(() => {
    setManualError(null);
  }, [paperId]);

  const handleExtract = async () => {
    const targetId = paperId;
    setManualError(null);
    setAssumptionsError(targetId, null);
    autoAnalyzedPapers.delete(`${targetId}:assumptions`);
    updateCachedAnalysis(targetId, { assumptions_cooldown_until: 0 });
    clearProgressStart(targetId, "assumptions");
    markRequestStart(targetId, "assumptions");
    setAssumptionsLoadingForPaper(targetId, true);
    try {
      const result = await api.getAssumptions(targetId);
      setAssumptionsForPaper(targetId, result.assumptions);
      updateCachedAnalysis(targetId, {
        assumptions: { assumptions: result.assumptions },
      });
      autoAnalyzedPapers.add(`${targetId}:assumptions`);
      if (currentPaperRef.current === targetId) {
        if (result.assumptions.length === 0) {
          // Defensive: if the backend ever relaxes its "no items = 502"
          // rule, still surface a clear message instead of dropping the
          // user back onto a silent "Extract" button.
          setManualError(
            "The model didn't find any explicit or implicit assumptions in this paper.",
          );
        }
      }
    } catch (e) {
      console.error("Assumptions extraction failed:", e);
      markAssumptionsAttemptFailed(targetId, updateCachedAnalysis);
      if (currentPaperRef.current === targetId) {
        const msg =
          e instanceof Error ? e.message : "Extraction failed. Please try again.";
        setManualError(msg);
        setAssumptionsError(targetId, msg);
      }
    } finally {
      markRequestEnd(targetId, "assumptions");
      clearProgressStart(targetId, "assumptions");
      setAssumptionsLoadingForPaper(targetId, false);
    }
  };

  // Hydrate from session/server cache only — auto-extract is owned by the
  // paper page so we don't double-fire (and loop) on mount.
  useEffect(() => {
    const pid = paperId;
    const cached =
      getCachedAssumptionItems(paperCache) ??
      getCachedAssumptionItems(sessionCache);
    if (cached && assumptions.length === 0) {
      setAssumptionsForPaper(pid, cached);
      autoAnalyzedPapers.add(`${pid}:assumptions`);
      if (!hasActiveRequest(pid, "assumptions")) {
        setAssumptionsLoadingForPaper(pid, false);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hydrate once per paper
  }, [paperId]);

  // Returning from dashboard can leave `assumptionsLoading` true even though
  // the in-memory list is already populated (no active request).
  useEffect(() => {
    if (
      assumptions.length > 0 &&
      assumptionsLoading &&
      !hasActiveRequest(paperId, "assumptions")
    ) {
      setAssumptionsLoadingForPaper(paperId, false);
    }
  }, [paperId, assumptions.length, assumptionsLoading, setAssumptionsLoadingForPaper]);

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
    const canExtract =
      !coolingDown && canAccess(tierUser?.tier || "free", "assumptions");
    return (
      <EmptyState
        title={
          coolingDown
            ? "Assumptions need a short pause"
            : displayError
              ? "Assumption extraction did not return results"
              : "Extract assumptions"
        }
        body={
          coolingDown
            ? "The model did not find usable assumptions on the last attempt. Try again in a few minutes."
            : displayError ||
              "Identify explicit and implicit assumptions in this paper."
        }
        cta={
          canExtract
            ? {
                label: displayError ? "Try again" : "Extract Assumptions",
                onClick: handleExtract,
              }
            : undefined
        }
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
