"use client";

import { useEffect, useRef } from "react";
import { experimental_useObject as useObject } from "@ai-sdk/react";
import { useStore } from "@/lib/store";
import { StreamingMarkdown } from "@/components/analysis/StreamingMarkdown";
import { AnalysisProgress } from "@/components/ui/AnalysisProgress";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionHeader } from "@/components/panel/SectionHeader";
import { PaperSummarySchema, type PaperSummary } from "@/lib/server/schemas";

interface SummaryPanelProps {
  paperId: string;
}

/**
 * Stage 3 migration:
 *   - The summary now streams via the Vercel AI SDK
 *     (`/api/papers/[id]/summary-stream`).
 *   - `experimental_useObject` parses the partial-JSON stream into a
 *     DeepPartial<PaperSummary>, so each section appears in the UI
 *     as soon as the model starts emitting it. The user no longer
 *     stares at a 30-second spinner; they see Overview within a few
 *     seconds, then Motivation, then Methodology, etc.
 *   - The server route persists the final assembled summary into
 *     `cached_analysis.summary` via the internal upsert, so a refresh
 *     keeps the result on subsequent visits.
 */
export function SummaryPanel({ paperId }: SummaryPanelProps) {
  const setSummary = useStore((s) => s.setSummary);
  const cachedSummary = useStore((s) => s.summary) ?? null;
  const paperCached = useStore((s) =>
    s.paper?.id === paperId ? s.paper?.cached_analysis?.summary : null,
  );
  const onActivePaper = useStore((s) => s.paper?.id === paperId);

  const triggered = useRef<string | null>(null);

  const {
    submit,
    object,
    isLoading,
    error,
    stop,
  } = useObject({
    id: paperId,
    api: `/api/papers/${paperId}/summary-stream`,
    schema: PaperSummarySchema,
    onFinish: ({ object: finalObject }) => {
      if (!finalObject) return;
      // Persist to the in-session zustand slice so other panels
      // (e.g. shared components, exports) read the freshly-streamed
      // summary without waiting for a refetch.
      if (useStore.getState().paper?.id === paperId) {
        setSummary(finalObject);
        useStore.getState().updateCachedAnalysis(paperId, {
          summary: finalObject,
        });
      }
    },
  });

  // Reset the "have we kicked off a stream yet?" guard when the user
  // switches papers — otherwise a slow / failed run on paper A would
  // suppress the auto-trigger when they navigate to paper B.
  useEffect(() => {
    triggered.current = null;
    return () => {
      stop();
    };
  }, [paperId, stop]);

  // Resolve the summary the panel should render. Order of preference:
  //   1. Live partial from the active stream.
  //   2. In-session zustand slice from a prior stream.
  //   3. cached_analysis.summary persisted on the paper row.
  const live = (object as Partial<PaperSummary> | undefined) ?? null;
  const fromStore = onActivePaper ? cachedSummary : null;
  const fromCache = onActivePaper ? (paperCached as PaperSummary | null) : null;
  const summary = live ?? fromStore ?? fromCache ?? null;

  // Auto-trigger a stream if there's no cached / in-session summary
  // for this paper and we haven't started one already.
  useEffect(() => {
    if (!onActivePaper) return;
    if (isLoading) return;
    if (fromStore || fromCache) return;
    if (triggered.current === paperId) return;
    triggered.current = paperId;
    submit({});
  }, [onActivePaper, isLoading, fromStore, fromCache, paperId, submit]);

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
    const errMsg = error
      ? readErrorMessage(error)
      : null;
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
            submit({});
          },
        }}
      />
    );
  }

  const s = summary as Partial<PaperSummary>;
  const stillStreaming = isLoading;

  return (
    <div className="space-y-8">
      {s.overview && (
        <section>
          <SectionHeader title="Overview" />
          <StreamingMarkdown streaming={stillStreaming && !s.motivation}>
            {s.overview}
          </StreamingMarkdown>
        </section>
      )}
      {s.motivation && (
        <section>
          <SectionHeader title="Motivation" />
          <StreamingMarkdown streaming={stillStreaming && !s.methodology}>
            {s.motivation}
          </StreamingMarkdown>
        </section>
      )}
      {s.key_contributions && s.key_contributions.length > 0 && (
        <section>
          <SectionHeader title="Key contributions" count={s.key_contributions.length} />
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
        </section>
      )}
      {s.methodology && (
        <section>
          <SectionHeader title="Methodology" />
          <StreamingMarkdown streaming={stillStreaming && !s.main_results}>
            {s.methodology}
          </StreamingMarkdown>
        </section>
      )}
      {s.main_results && (
        <section>
          <SectionHeader title="Main results" />
          <StreamingMarkdown streaming={stillStreaming && !s.discussion}>
            {s.main_results}
          </StreamingMarkdown>
        </section>
      )}
      {s.discussion && (
        <section>
          <SectionHeader title="Discussion" />
          <StreamingMarkdown streaming={stillStreaming && !s.future_work}>
            {s.discussion}
          </StreamingMarkdown>
        </section>
      )}
      {s.key_equations && s.key_equations.length > 0 && (
        <section>
          <SectionHeader title="Key equations" count={s.key_equations.length} />
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
        </section>
      )}
      {s.key_figures_and_tables && s.key_figures_and_tables.length > 0 && (
        <section>
          <SectionHeader title="Key figures & tables" count={s.key_figures_and_tables.length} />
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
        </section>
      )}
      {s.limitations && s.limitations.length > 0 && (
        <section>
          <SectionHeader title="Limitations" count={s.limitations.length} />
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
        </section>
      )}
      {s.future_work && (
        <section>
          <SectionHeader title="Future work" />
          <StreamingMarkdown streaming={stillStreaming}>
            {s.future_work}
          </StreamingMarkdown>
        </section>
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
