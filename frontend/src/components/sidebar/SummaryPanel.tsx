"use client";

import { Fragment, useCallback, useMemo, useState } from "react";
import { useStore } from "@/lib/store";
import { StreamingMarkdown } from "@/components/analysis/StreamingMarkdown";
import { AnalysisSection } from "@/components/analysis/AnalysisSection";
import { CardMeta } from "@/components/analysis/CardMeta";
import { ReadMoreProse } from "@/components/analysis/ReadMoreProse";
import { AnalysisProgress } from "@/components/ui/AnalysisProgress";
import { EmptyState } from "@/components/ui/EmptyState";
import type { PaperSummary } from "@/lib/api";
import {
  clearProgressStart,
  hasActiveRequest,
  summaryStreamStarters,
  summaryAutoRetryCooldownUntil,
} from "@/lib/analysisState";
import { ensureDisplayMath, firstSentence } from "@/lib/text";
import {
  hasSummaryDeepBody,
  summaryIsComplete,
} from "@/lib/summaryState";
import {
  paperHasFiguresOrTables,
  paperLikelyHasEquations,
  summaryKeyEquations,
  summaryKeyFiguresAndTables,
} from "@/lib/summarySections";
import { useUserSettings } from "@/lib/UserSettingsContext";
import { modelsMatch } from "@/lib/modelLabels";
interface SummaryPanelProps {
  paperId: string;
}

function hasSummaryBody(value: Partial<PaperSummary> | null | undefined): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.keys(value).some((k) => {
    if (k === "model" || k === "created_at") return false;
    const v = value[k as keyof PaperSummary];
    if (typeof v === "string") return v.trim().length > 0;
    return Array.isArray(v) && v.length > 0;
  });
}

export function SummaryPanel({ paperId }: SummaryPanelProps) {
  const { analysisModel } = useUserSettings();
  const paperMeta = useStore((s) =>
    s.paper?.id === paperId ? s.paper : s.papersById[paperId] ?? null,
  );
  // Per-paper slot is the single source of truth — `useSummary` merges
  // lite + deep + cached payloads into this slot. Switching tabs never
  // wipes it; late writes for paper A cannot bleed into paper B.
  const summaryFromStore = useStore((s) => s.summaryByPaper[paperId] ?? null);
  const summaryLoading = useStore(
    (s) => s.summaryLoadingByPaper[paperId] ?? false,
  );
  // Select stable slice references only — Zustand's `useSyncExternalStore`
  // calls the snapshot getter twice per render to detect tearing, and
  // returning a freshly-spread object here triggers React error #185 the
  // moment the store updates during streaming. Merge inside `useMemo`.
  const cachedSummaryLite = useStore(
    (s) =>
      (s.papersById[paperId]?.cached_analysis?.summary_lite as
        | PaperSummary
        | undefined) ?? null,
  );
  const cachedSummaryDeep = useStore(
    (s) =>
      (s.papersById[paperId]?.cached_analysis?.summary_deep as
        | PaperSummary
        | undefined) ?? null,
  );
  const cachedSummaryLegacy = useStore(
    (s) =>
      (s.papersById[paperId]?.cached_analysis?.summary as
        | PaperSummary
        | undefined) ?? null,
  );
  const paperCachedSummary = useMemo<PaperSummary | null>(() => {
    if (!cachedSummaryLite && !cachedSummaryDeep && !cachedSummaryLegacy) {
      return null;
    }
    return {
      ...(cachedSummaryLegacy ?? {}),
      ...(cachedSummaryDeep ?? {}),
      ...(cachedSummaryLite ?? {}),
    } as PaperSummary;
  }, [cachedSummaryLite, cachedSummaryDeep, cachedSummaryLegacy]);
  const storedError = useStore((s) => s.summaryErrorByPaper[paperId] ?? null);
  const [manualError, setManualError] = useState<string | null>(null);
  const summaryRaw = (summaryFromStore ??
    paperCachedSummary ??
    null) as Partial<PaperSummary> | null;
  const isComplete = summaryIsComplete(summaryRaw);
  const isGenerating =
    summaryLoading || hasActiveRequest(paperId, "summary");
  const summary = isComplete ? summaryRaw : null;
  const isLoading = isGenerating && !isComplete;

  const runSummaryStream = useCallback(
    (opts?: { force?: boolean }) => {
      if (hasActiveRequest(paperId, "summary")) return;
      setManualError(null);
      summaryAutoRetryCooldownUntil.delete(paperId);
      clearProgressStart(paperId, "summary");
      const start = summaryStreamStarters.get(paperId);
      if (!start) {
        setManualError("Summary is still initializing. Try again in a moment.");
        return;
      }
      start(opts);
    },
    [paperId],
  );

  if (isLoading) {
    return (
      <div className="flex flex-col items-center gap-2 py-6">
        <div className="w-full max-w-[16rem]">
          <AnalysisProgress kind="summary" paperId={paperId} />
        </div>
        <p className="text-[var(--text-xs)] text-muted-foreground/85">
          Generating detailed summary…
        </p>
      </div>
    );
  }

  if (!summary) {
    const errMsg = manualError || storedError;
    const liteOnly =
      hasSummaryBody(summaryRaw) && !hasSummaryDeepBody(summaryRaw);
    return (
      <EmptyState
        title={errMsg ? "Failed to generate summary" : "Summary not available yet"}
        body={
          errMsg ||
          (liteOnly
            ? "The overview finished but the deep sections did not. Retry to generate methodology, results, and discussion."
            : "Generate a detailed overview, contributions, methods, results, and limitations. Generation often takes 30–90 seconds once started.")
        }
        cta={{
          label: errMsg || liteOnly ? "Retry" : "Generate Summary",
          onClick: () => {
            void runSummaryStream(liteOnly ? undefined : { force: true });
          },
        }}
      />
    );
  }

  const s = summary!;
  const keyEquations = summaryKeyEquations(s);
  const keyFigures = summaryKeyFiguresAndTables(s);
  const showKeyEquations =
    keyEquations.length > 0 && paperLikelyHasEquations(paperMeta);
  const showKeyFigures =
    keyFigures.length > 0 && paperHasFiguresOrTables(paperMeta);
  const modelStale =
    !!s.model && !!analysisModel && !modelsMatch(s.model, analysisModel);

  const takeawaySource =
    (s as PaperSummary & { tl_dr?: string }).tl_dr ?? s.overview ?? "";
  // Render the takeaway as soon as we have it (don't wait for the
  // whole stream to finish) — it's the highest-signal field.
  const takeaway = firstSentence(takeawaySource, 240);

  return (
    <div className="space-y-8">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-display text-[var(--text-md)] font-medium tracking-[-0.02em] text-foreground">
          Summary
        </h2>
        {s.model || analysisModel ? (
          <CardMeta
            model={s.model ?? analysisModel}
            createdAt={s.created_at}
            pending={!s.model}
          />
        ) : null}
      </div>

      {modelStale && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-lg)] border border-border/50 bg-muted/[0.06] px-4 py-3">
          <p className="text-[var(--text-xs)] text-muted-foreground">
            Generated with a different analysis model. Regenerate to use your current
            setting.
          </p>
          <button
            type="button"
            onClick={() => {
              void runSummaryStream({ force: true });
            }}
            className="shrink-0 rounded-md border border-border/50 bg-card/35 px-3 py-1.5 text-[var(--text-xs)] font-medium text-foreground hover:bg-accent/50 motion-safe:duration-150"
          >
            Regenerate
          </button>
        </div>
      )}

      {takeaway && (
        <div className="rounded-[var(--radius-lg)] border border-border/50 bg-card/35 px-4 py-3 dark:bg-card/22">
          <p className="text-[var(--text-xs)] font-medium uppercase tracking-[0.12em] text-muted-foreground/85">
            Key takeaway
          </p>
          <div className="mt-1 text-[var(--text-sm)] leading-relaxed text-foreground/90">
            <StreamingMarkdown>{takeaway}</StreamingMarkdown>
          </div>
        </div>
      )}

      {s.overview && (
        <AnalysisSection title="Overview">
          <ReadMoreProse markdown={s.overview}>
            <StreamingMarkdown>{s.overview}</StreamingMarkdown>
          </ReadMoreProse>
        </AnalysisSection>
      )}
      {s.motivation && (
        <AnalysisSection title="Motivation">
          <StreamingMarkdown>{s.motivation}</StreamingMarkdown>
        </AnalysisSection>
      )}
      {s.key_contributions && s.key_contributions.length > 0 && (
        <AnalysisSection title="Key contributions" count={s.key_contributions.length}>
          <ul className="space-y-2">
            {s.key_contributions.map((c, i) => (
              <li key={i} className="flex gap-2">
                <span className="mt-0.5 shrink-0 text-[var(--text-sm)] text-muted-foreground/50">
                  {i + 1}.
                </span>
                <div className="min-w-0 flex-1">
                  <StreamingMarkdown>{c}</StreamingMarkdown>
                </div>
              </li>
            ))}
          </ul>
        </AnalysisSection>
      )}
      {s.methodology && (
        <AnalysisSection title="Methodology">
          <ReadMoreProse markdown={s.methodology}>
            <StreamingMarkdown>{s.methodology}</StreamingMarkdown>
          </ReadMoreProse>
        </AnalysisSection>
      )}
      {s.main_results && (
        <AnalysisSection title="Main results">
          <ReadMoreProse markdown={s.main_results}>
            <StreamingMarkdown>{s.main_results}</StreamingMarkdown>
          </ReadMoreProse>
        </AnalysisSection>
      )}
      {s.discussion && (
        <AnalysisSection title="Discussion">
          <ReadMoreProse markdown={s.discussion}>
            <StreamingMarkdown>{s.discussion}</StreamingMarkdown>
          </ReadMoreProse>
        </AnalysisSection>
      )}
      {showKeyEquations && (
        <AnalysisSection title="Key equations" count={keyEquations.length}>
          <div className="space-y-3">
            {keyEquations.map((eq, i) => {
              if (!eq) return null;
              const terms = (eq as { terms?: { symbol?: string; meaning?: string }[] }).terms;
              return (
                <div
                  key={i}
                  className="overflow-hidden rounded-lg border border-border/50 bg-card/35 dark:bg-card/22"
                >
                  <div className="border-b border-border/50 px-4 py-3">
                    <StreamingMarkdown>{ensureDisplayMath(eq.equation)}</StreamingMarkdown>
                  </div>
                  {eq.meaning && (
                    <div className="px-4 py-3 text-[var(--text-sm)] leading-relaxed text-muted-foreground">
                      <StreamingMarkdown>{eq.meaning}</StreamingMarkdown>
                    </div>
                  )}
                  {terms && terms.length > 0 && (
                    <div className="border-t border-border/45 bg-muted/[0.06] px-4 py-3">
                      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
                        Where
                      </p>
                      <dl className="grid grid-cols-[minmax(2.5rem,auto)_1fr] gap-x-3 gap-y-1.5 text-[var(--text-sm)] leading-snug">
                        {terms.map((t, k) => (
                          <Fragment key={k}>
                            <dt className="text-foreground">
                              <StreamingMarkdown>{t.symbol ?? ""}</StreamingMarkdown>
                            </dt>
                            <dd className="text-muted-foreground">
                              <StreamingMarkdown>{t.meaning ?? ""}</StreamingMarkdown>
                            </dd>
                          </Fragment>
                        ))}
                      </dl>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </AnalysisSection>
      )}
      {showKeyFigures && (
        <AnalysisSection title="Key figures & tables" count={keyFigures.length}>
          <div className="overflow-hidden rounded-lg border border-border/50 bg-card/35 dark:bg-card/22">
            {keyFigures.map((fig, i) => {
              if (!fig) return null;
              return (
                <div
                  key={i}
                  className="border-b border-border/60 px-4 py-3 last:border-b-0 motion-safe:transition-colors motion-safe:duration-150 hover:bg-accent/40"
                >
                  <p className="text-[var(--text-sm)] font-medium text-foreground">{fig.id}</p>
                  <div className="mt-0.5 text-[var(--text-sm)] text-muted-foreground">
                    <StreamingMarkdown>{fig.description ?? ""}</StreamingMarkdown>
                  </div>
                </div>
              );
            })}
          </div>
        </AnalysisSection>
      )}
      {s.limitations && s.limitations.length > 0 && (
        <AnalysisSection title="Limitations" count={s.limitations.length}>
          <ul className="space-y-1">
            {s.limitations.map((l, i) => (
              <li key={i} className="flex gap-2">
                <span className="shrink-0 text-[var(--text-sm)] text-muted-foreground/50">•</span>
                <div className="min-w-0 flex-1">
                  <StreamingMarkdown>{l}</StreamingMarkdown>
                </div>
              </li>
            ))}
          </ul>
        </AnalysisSection>
      )}
      {s.future_work && (
        <AnalysisSection title="Future work">
          <StreamingMarkdown>{s.future_work}</StreamingMarkdown>
        </AnalysisSection>
      )}
    </div>
  );
}
