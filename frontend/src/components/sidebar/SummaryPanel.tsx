"use client";

import { useCallback, useState } from "react";
import { useStore } from "@/lib/store";
import { StreamingMarkdown } from "@/components/analysis/StreamingMarkdown";
import { AnalysisSection } from "@/components/analysis/AnalysisSection";
import { CardMeta } from "@/components/analysis/CardMeta";
import { ReadMoreProse } from "@/components/analysis/ReadMoreProse";
import { AnalysisProgress } from "@/components/ui/AnalysisProgress";
import { EmptyState } from "@/components/ui/EmptyState";
import type { PaperSummary } from "@/lib/server/schemas";
import {
  clearProgressStart,
  hasActiveRequest,
  summaryStreamStarters,
} from "@/lib/analysisState";

interface SummaryPanelProps {
  paperId: string;
}

export function SummaryPanel({ paperId }: SummaryPanelProps) {
  const cachedSummary = useStore((s) => s.summary) ?? null;
  const streamingPartial = useStore((s) => s.summaryStreamingByPaper[paperId] ?? null);
  const summaryLoading = useStore((s) => s.summaryLoading);
  const paperCached = useStore((s) =>
    s.paper?.id === paperId ? s.paper?.cached_analysis?.summary : null,
  );
  const onActivePaper = useStore((s) => s.paper?.id === paperId);
  const storedError = useStore((s) => s.summaryErrorByPaper[paperId] ?? null);
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

  const runSummaryStream = useCallback(() => {
    if (hasActiveRequest(paperId, "summary")) return;
    setManualError(null);
    clearProgressStart(paperId, "summary");
    const start = summaryStreamStarters.get(paperId);
    if (!start) {
      setManualError("Summary is still initializing. Try again in a moment.");
      return;
    }
    start();
  }, [paperId]);

  if (!summary && isLoading) {
    return (
      <div className="flex flex-col items-center gap-2 py-6">
        <div className="w-full max-w-[16rem]">
          <AnalysisProgress kind="summary" paperId={paperId} />
        </div>
        <p className="text-[var(--text-xs)] text-muted-foreground/85">Generating detailed summary…</p>
      </div>
    );
  }

  if (!summary) {
    const errMsg = manualError || storedError;
    return (
      <EmptyState
        title={errMsg ? "Failed to generate summary" : "Summary not available yet"}
        body={
          errMsg ||
          "Generate a detailed overview, contributions, methods, results, and limitations. Generation often takes 30–90 seconds once started."
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

  const takeawaySource = (s as PaperSummary & { tl_dr?: string }).tl_dr ?? s.overview;
  const takeaway =
    takeawaySource && takeawaySource.length > 180
      ? `${takeawaySource.slice(0, 180).trim()}…`
      : takeawaySource;

  return (
    <div className="space-y-8">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-display text-[var(--text-md)] font-medium tracking-[-0.02em] text-foreground">
          Summary
        </h2>
        <CardMeta model={s.model} createdAt={s.created_at} />
      </div>

      {takeaway && (
        <div className="rounded-[var(--radius-lg)] border border-border/50 bg-card/35 px-4 py-3 dark:bg-card/22">
          <p className="text-[var(--text-xs)] font-medium uppercase tracking-[0.12em] text-muted-foreground/85">
            Key takeaway
          </p>
          <p className="mt-1 text-[var(--text-sm)] leading-relaxed text-foreground/90">{takeaway}</p>
        </div>
      )}

      {s.overview && (
        <AnalysisSection title="Overview">
          <ReadMoreProse markdown={s.overview} streaming={stillStreaming && streamingCursorField === "overview"}>
            <StreamingMarkdown streaming={streamingCursorField === "overview"}>
              {s.overview}
            </StreamingMarkdown>
          </ReadMoreProse>
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
          <ReadMoreProse markdown={s.methodology} streaming={stillStreaming && streamingCursorField === "methodology"}>
            <StreamingMarkdown streaming={streamingCursorField === "methodology"}>
              {s.methodology}
            </StreamingMarkdown>
          </ReadMoreProse>
        </AnalysisSection>
      )}
      {s.main_results && (
        <AnalysisSection title="Main results">
          <ReadMoreProse markdown={s.main_results} streaming={stillStreaming && streamingCursorField === "main_results"}>
            <StreamingMarkdown streaming={streamingCursorField === "main_results"}>
              {s.main_results}
            </StreamingMarkdown>
          </ReadMoreProse>
        </AnalysisSection>
      )}
      {s.discussion && (
        <AnalysisSection title="Discussion">
          <ReadMoreProse markdown={s.discussion} streaming={stillStreaming && streamingCursorField === "discussion"}>
            <StreamingMarkdown streaming={streamingCursorField === "discussion"}>
              {s.discussion}
            </StreamingMarkdown>
          </ReadMoreProse>
        </AnalysisSection>
      )}
      {s.key_equations && s.key_equations.length > 0 && (
        <AnalysisSection title="Key equations" count={s.key_equations.length}>
          <div className="overflow-hidden rounded-lg border border-border/50 bg-card/35 dark:bg-card/22">
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
          <div className="overflow-hidden rounded-lg border border-border/50 bg-card/35 dark:bg-card/22">
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
