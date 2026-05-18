"use client";

import { useCallback, useState } from "react";
import { useStore } from "@/lib/store";
import { StreamingMarkdown } from "@/components/analysis/StreamingMarkdown";
import { AnalysisSection } from "@/components/analysis/AnalysisSection";
import { AnalysisProgress } from "@/components/ui/AnalysisProgress";
import { EmptyState } from "@/components/ui/EmptyState";
import type { PaperSummary } from "@/lib/server/schemas";
import {
  activeSummaryStreams,
  clearProgressStart,
  hasActiveRequest,
  markRequestEnd,
  markRequestStart,
} from "@/lib/analysisState";
import { streamSummaryForPaper, SummaryStreamError } from "@/lib/streamSummary";

interface SummaryPanelProps {
  paperId: string;
}

export function SummaryPanel({ paperId }: SummaryPanelProps) {
  const setSummary = useStore((s) => s.setSummary);
  const cachedSummary = useStore((s) => s.summary) ?? null;
  const streamingPartial = useStore((s) => s.summaryStreamingByPaper[paperId] ?? null);
  const summaryLoading = useStore((s) => s.summaryLoading);
  const paperCached = useStore((s) =>
    s.paper?.id === paperId ? s.paper?.cached_analysis?.summary : null,
  );
  const onActivePaper = useStore((s) => s.paper?.id === paperId);
  const [manualError, setManualError] = useState<string | null>(null);
  const fromStore = onActivePaper ? cachedSummary : null;
  const fromCache = onActivePaper ? (paperCached as PaperSummary | null) : null;
  const live = onActivePaper ? streamingPartial : null;
  const summary = (live ?? fromStore ?? fromCache ?? null) as Partial<PaperSummary> | null;
  const isLoading =
    onActivePaper &&
    (summaryLoading || hasActiveRequest(paperId, "summary")) &&
    !fromStore &&
    !fromCache;

  const runSummaryStream = useCallback(async () => {
    if (hasActiveRequest(paperId, "summary")) return;
    setManualError(null);
    const ac = new AbortController();
    activeSummaryStreams.set(paperId, ac);
    markRequestStart(paperId, "summary");
    useStore.getState().setSummaryLoading(true);
    clearProgressStart(paperId, "summary");
    try {
      const finalSummary = await streamSummaryForPaper(paperId, ac.signal);
      if (useStore.getState().paper?.id !== paperId) return;
      if (finalSummary) {
        setSummary(finalSummary);
        useStore.getState().updateCachedAnalysis(paperId, { summary: finalSummary });
      } else if (!useStore.getState().summary) {
        setManualError("Summary generation finished without content. Try again.");
      }
    } catch (e) {
      if (useStore.getState().paper?.id === paperId) {
        setManualError(
          e instanceof SummaryStreamError
            ? e.message
            : e instanceof Error
              ? e.message
              : "Summary generation failed.",
        );
      }
    } finally {
      markRequestEnd(paperId, "summary");
      clearProgressStart(paperId, "summary");
      activeSummaryStreams.delete(paperId);
      if (useStore.getState().paper?.id === paperId) {
        useStore.getState().setSummaryLoading(false);
      }
    }
  }, [paperId, setSummary]);

  if (!summary && isLoading) {
    return (
      <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 py-12">
        <div className="w-full max-w-xs">
          <AnalysisProgress kind="summary" paperId={paperId} />
        </div>
        <p className="text-[var(--text-sm)] text-muted-foreground">Generating detailed summary…</p>
      </div>
    );
  }

  if (!summary) {
    const errMsg = manualError;
    return (
      <EmptyState
        title={errMsg ? "Failed to generate summary" : "Summary not available yet"}
        body={
          errMsg ||
          "Generate a detailed overview, contributions, methods, results, and limitations. Generation often takes 30–60 seconds once started."
        }
        cta={{
          label: errMsg ? "Retry" : "Generate Summary",
          onClick: () => {
            void runSummaryStream();
          },
        }}
      />
    );
  }

  const s = summary;
  const stillStreaming = isLoading;
  const FIELD_ORDER = [
    "overview",
    "motivation",
    "methodology",
    "main_results",
    "discussion",
    "future_work",
  ] as const;
  const streamingCursorField = (() => {
    if (!stillStreaming) return null;
    for (const f of FIELD_ORDER) {
      if (!s[f]) return f;
    }
    return null;
  })();

  return (
    <div className="space-y-8">
      {s.overview && (
        <AnalysisSection title="Overview">
          <StreamingMarkdown streaming={streamingCursorField === "overview"}>
            {s.overview}
          </StreamingMarkdown>
        </AnalysisSection>
      )}
      {s.motivation && (
        <AnalysisSection title="Motivation">
          <StreamingMarkdown streaming={streamingCursorField === "motivation"}>
            {s.motivation}
          </StreamingMarkdown>
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
          <StreamingMarkdown streaming={streamingCursorField === "methodology"}>
            {s.methodology}
          </StreamingMarkdown>
        </AnalysisSection>
      )}
      {s.main_results && (
        <AnalysisSection title="Main results">
          <StreamingMarkdown streaming={streamingCursorField === "main_results"}>
            {s.main_results}
          </StreamingMarkdown>
        </AnalysisSection>
      )}
      {s.discussion && (
        <AnalysisSection title="Discussion">
          <StreamingMarkdown streaming={streamingCursorField === "discussion"}>
            {s.discussion}
          </StreamingMarkdown>
        </AnalysisSection>
      )}
      {s.key_equations && s.key_equations.length > 0 && (
        <AnalysisSection title="Key equations" count={s.key_equations.length}>
          <div className="overflow-hidden rounded-lg border border-border/60 bg-card/30">
            {s.key_equations.map((eq, i) => {
              if (!eq) return null;
              return (
                <div
                  key={i}
                  className="border-b border-border/60 px-4 py-3 last:border-b-0 motion-safe:transition-colors motion-safe:duration-150 hover:bg-accent/40"
                >
                  <StreamingMarkdown>{eq.equation ?? ""}</StreamingMarkdown>
                  <div className="mt-1.5 text-[var(--text-sm)] text-muted-foreground">
                    <StreamingMarkdown>{eq.meaning ?? ""}</StreamingMarkdown>
                  </div>
                </div>
              );
            })}
          </div>
        </AnalysisSection>
      )}
      {s.key_figures_and_tables && s.key_figures_and_tables.length > 0 && (
        <AnalysisSection title="Key figures & tables" count={s.key_figures_and_tables.length}>
          <div className="overflow-hidden rounded-lg border border-border/60 bg-card/30">
            {s.key_figures_and_tables.map((fig, i) => {
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
          <StreamingMarkdown streaming={streamingCursorField === "future_work"}>
            {s.future_work}
          </StreamingMarkdown>
        </AnalysisSection>
      )}
    </div>
  );
}
