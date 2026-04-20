"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { Md } from "@/components/ui/Md";

interface SummaryPanelProps {
  paperId: string;
}

export function SummaryPanel({ paperId }: SummaryPanelProps) {
  const { summary, setSummary, summaryLoading, setSummaryLoading, paper } = useStore();
  const fetchAttempted = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [fetchError, setFetchError] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [streaming, setStreaming] = useState(false);

  const effectiveSummary = summary ?? (paper?.id === paperId ? paper?.cached_analysis?.summary : null) ?? null;

  const startStream = useCallback(async (targetId: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setFetchError(false);
    setSummaryLoading(true);
    setStreaming(true);
    setStreamText("");

    try {
      const res = await api.getSummaryStream(targetId, controller.signal);
      if (controller.signal.aborted) return;
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No stream");

      const decoder = new TextDecoder();
      let buffer = "";
      let accumulated = "";

      while (true) {
        if (controller.signal.aborted) { reader.cancel(); break; }
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === "chunk") {
              accumulated += event.text;
              setStreamText(accumulated);
            } else if (event.type === "done") {
              if (event.summary && useStore.getState().paper?.id === targetId) {
                setSummary(event.summary);
              }
              setStreaming(false);
              setSummaryLoading(false);
            } else if (event.type === "error") {
              throw new Error(event.message);
            }
          } catch (e) {
            if (e instanceof SyntaxError) continue;
            throw e;
          }
        }
      }
    } catch (e) {
      if (controller.signal.aborted) return;
      if (useStore.getState().paper?.id === targetId) setFetchError(true);
    } finally {
      setStreaming(false);
      setSummaryLoading(false);
    }
  }, [setSummary, setSummaryLoading]);

  useEffect(() => {
    if (effectiveSummary && paper?.id === paperId) {
      if (!summary) setSummary(effectiveSummary);
      return;
    }
    if (paper?.id !== paperId) return;
    if (fetchAttempted.current === paperId) return;
    fetchAttempted.current = paperId;
    startStream(paperId);
    return () => { abortRef.current?.abort(); };
  }, [paperId, effectiveSummary, summary, paper, setSummary, startStream]);

  if (streaming || (summaryLoading && !effectiveSummary)) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 border-2 border-muted-foreground/30 border-t-foreground rounded-full animate-spin shrink-0" />
          <p className="text-[13px] text-muted-foreground">Generating summary...</p>
        </div>
        {streamText ? (
          <div className="prose prose-sm dark:prose-invert max-w-none text-[13px] leading-relaxed opacity-80">
            <Md>{streamText}</Md>
            <span className="inline-block w-1.5 h-4 bg-foreground/60 animate-pulse ml-0.5 align-text-bottom rounded-sm" />
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground/50">This may take 30-60 seconds</p>
        )}
      </div>
    );
  }

  if (!effectiveSummary) {
    return (
      <div className="text-center py-8">
        <p className="text-[13px] text-muted-foreground/60">
          {fetchError ? "Failed to generate summary." : "Summary not available yet."}
        </p>
        <button
          onClick={() => {
            fetchAttempted.current = null;
            startStream(paperId);
          }}
          className="mt-2 text-[12px] font-medium text-foreground hover:opacity-80 transition-opacity"
        >
          {fetchError ? "Retry" : "Generate Summary"}
        </button>
      </div>
    );
  }

  const s = effectiveSummary;

  return (
    <div className="space-y-5">
      {s.overview && (
        <section>
          <h3 className="text-[13px] font-semibold uppercase tracking-widest text-muted-foreground/70 mb-2">Overview</h3>
          <Md>{s.overview}</Md>
        </section>
      )}
      {s.motivation && (
        <section>
          <h3 className="text-[13px] font-semibold uppercase tracking-widest text-muted-foreground/70 mb-2">Motivation</h3>
          <Md>{s.motivation}</Md>
        </section>
      )}
      {s.key_contributions?.length > 0 && (
        <section>
          <h3 className="text-[13px] font-semibold uppercase tracking-widest text-muted-foreground/70 mb-2">Key Contributions</h3>
          <ul className="space-y-1.5">
            {s.key_contributions.map((c, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-[12px] text-muted-foreground/40 shrink-0 mt-0.5">{i + 1}.</span>
                <Md>{c}</Md>
              </li>
            ))}
          </ul>
        </section>
      )}
      {s.methodology && (
        <section>
          <h3 className="text-[13px] font-semibold uppercase tracking-widest text-muted-foreground/70 mb-2">Methodology</h3>
          <Md>{s.methodology}</Md>
        </section>
      )}
      {s.main_results && (
        <section>
          <h3 className="text-[13px] font-semibold uppercase tracking-widest text-muted-foreground/70 mb-2">Main Results</h3>
          <Md>{s.main_results}</Md>
        </section>
      )}
      {s.discussion && (
        <section>
          <h3 className="text-[13px] font-semibold uppercase tracking-widest text-muted-foreground/70 mb-2">Discussion</h3>
          <Md>{s.discussion}</Md>
        </section>
      )}
      {s.key_equations?.length > 0 && (
        <section>
          <h3 className="text-[13px] font-semibold uppercase tracking-widest text-muted-foreground/70 mb-2">Key Equations</h3>
          <div className="space-y-2">
            {s.key_equations.map((eq, i) => (
              <div key={i} className="rounded-xl glass-subtle px-3.5 py-2.5">
                <Md>{eq.equation}</Md>
                <div className="text-[12px] text-muted-foreground mt-1"><Md>{eq.meaning}</Md></div>
              </div>
            ))}
          </div>
        </section>
      )}
      {s.key_figures_and_tables?.length > 0 && (
        <section>
          <h3 className="text-[13px] font-semibold uppercase tracking-widest text-muted-foreground/70 mb-2">Key Figures & Tables</h3>
          <div className="space-y-1.5">
            {s.key_figures_and_tables.map((fig, i) => (
              <div key={i} className="rounded-xl glass-subtle px-3.5 py-2.5">
                <span className="text-[12px] font-semibold">{fig.id}</span>
                <div className="text-[12px] text-muted-foreground mt-0.5"><Md>{fig.description}</Md></div>
              </div>
            ))}
          </div>
        </section>
      )}
      {s.limitations?.length > 0 && (
        <section>
          <h3 className="text-[13px] font-semibold uppercase tracking-widest text-muted-foreground/70 mb-2">Limitations</h3>
          <ul className="space-y-1">
            {s.limitations.map((l, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-[12px] text-muted-foreground/40 shrink-0">•</span>
                <Md>{l}</Md>
              </li>
            ))}
          </ul>
        </section>
      )}
      {s.future_work && (
        <section>
          <h3 className="text-[13px] font-semibold uppercase tracking-widest text-muted-foreground/70 mb-2">Future Work</h3>
          <Md>{s.future_work}</Md>
        </section>
      )}
    </div>
  );
}
