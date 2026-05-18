"use client";

import { useEffect, useRef } from "react";
import { experimental_useObject as useObject } from "@ai-sdk/react";
import { useStore } from "@/lib/store";
import { StreamingMarkdown } from "@/components/analysis/StreamingMarkdown";
import { AnalysisSection } from "@/components/analysis/AnalysisSection";
import { AnalysisProgress } from "@/components/ui/AnalysisProgress";
import { EmptyState } from "@/components/ui/EmptyState";
import { PaperSummarySchema, type PaperSummary } from "@/lib/server/schemas";

interface SummaryPanelProps {
  paperId: string;
}

/**
 * Stage 5 refactor:
 *   - Sections are array-driven via `AnalysisSection`. Replaces seven
 *     near-identical `<section><SectionHeader />…</section>` blocks
 *     that diverged subtly across the panel.
 *   - Streaming + cache + auto-trigger logic preserved verbatim from
 *     stage 3; only the render layer changes.
 */
export function SummaryPanel({ paperId }: SummaryPanelProps) {
  const setSummary = useStore((s) => s.setSummary);
  const cachedSummary = useStore((s) => s.summary) ?? null;
  const paperCached = useStore((s) =>
    s.paper?.id === paperId ? s.paper?.cached_analysis?.summary : null,
  );
  const onActivePaper = useStore((s) => s.paper?.id === paperId);

  const triggered = useRef<string | null>(null);

  const { submit, object, isLoading, error, stop } = useObject({
    id: paperId,
    api: `/api/papers/${paperId}/summary-stream`,
    schema: PaperSummarySchema,
    onFinish: ({ object: finalObject }) => {
      if (!finalObject) return;
      if (useStore.getState().paper?.id === paperId) {
        setSummary(finalObject);
        useStore.getState().updateCachedAnalysis(paperId, {
          summary: finalObject,
        });
      }
    },
  });

  // `stop` and `submit` from `experimental_useObject` are recreated on
  // every render. Putting either in a useEffect dep array re-fires
  // the effect on every render — for `stop` that aborted any
  // in-flight stream; for `submit` it would re-fire the auto-trigger
  // even after the guard condition was supposed to be stable. Stash
  // both in refs so deps stay coherent.
  const stopRef = useRef(stop);
  stopRef.current = stop;
  const submitRef = useRef(submit);
  submitRef.current = submit;

  useEffect(() => {
    triggered.current = null;
    return () => {
      stopRef.current();
    };
  }, [paperId]);

  const live = (object as Partial<PaperSummary> | undefined) ?? null;
  const fromStore = onActivePaper ? cachedSummary : null;
  const fromCache = onActivePaper ? (paperCached as PaperSummary | null) : null;
  const summary = live ?? fromStore ?? fromCache ?? null;

  useEffect(() => {
    if (!onActivePaper) return;
    if (isLoading) return;
    if (fromStore || fromCache) return;
    if (triggered.current === paperId) return;
    triggered.current = paperId;
    submitRef.current({});
  }, [onActivePaper, isLoading, fromStore, fromCache, paperId]);

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
    const errMsg = error ? readErrorMessage(error) : null;
    return (
      <EmptyState
        title={errMsg ? "Failed to generate summary" : "Summary not available yet"}
        body={
          errMsg
            ? errMsg
            : "Generate a detailed overview, contributions, methods, results, and limitations. Generation often takes 30–60 seconds once started."
        }
        cta={{
          label: errMsg ? "Retry" : "Generate Summary",
          onClick: () => {
            triggered.current = paperId;
            submitRef.current({});
          },
        }}
      />
    );
  }

  const s = summary as Partial<PaperSummary>;
  const stillStreaming = isLoading;
  // For the in-flight stream, the "current" section is the last one
  // that hasn't started filling — show the streaming caret on it so
  // users can see progress front-to-back. Fields are intentionally
  // produced in this order by the schema.
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

function readErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(message) as { detail?: { code?: string; message?: string } };
    if (parsed.detail?.message) return parsed.detail.message;
  } catch {
    /* not JSON */
  }
  return message || "Summary generation failed.";
}
