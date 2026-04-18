"use client";

import { useEffect, useState, useRef } from "react";
import { api } from "@/lib/api";
import { useStore } from "@/lib/store";
import { Md } from "@/components/ui/Md";

interface SummaryPanelProps {
  paperId: string;
}

function SummaryProgressBar() {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const interval = setInterval(() => {
      const elapsed = (Date.now() - start) / 1000;
      setWidth(Math.min(90, 90 * (1 - Math.exp(-elapsed / 20))));
    }, 200);
    return () => clearInterval(interval);
  }, []);
  return (
    <div className="w-full max-w-xs h-1.5 bg-accent rounded-full overflow-hidden">
      <div
        className="h-full bg-foreground/60 rounded-full transition-all duration-300 ease-out"
        style={{ width: `${width}%` }}
      />
    </div>
  );
}

export function SummaryPanel({ paperId }: SummaryPanelProps) {
  const { summary, setSummary, summaryLoading, setSummaryLoading, paper } = useStore();
  const fetchAttempted = useRef<string | null>(null);
  const [fetchError, setFetchError] = useState(false);

  useEffect(() => {
    if (summary) return;
    if (paper?.cached_analysis?.summary) {
      setSummary(paper.cached_analysis.summary);
      return;
    }
    if (fetchAttempted.current === paperId) return;
    fetchAttempted.current = paperId;
    setFetchError(false);
    setSummaryLoading(true);
    api
      .getSummary(paperId)
      .then((r) => setSummary(r))
      .catch(() => setFetchError(true))
      .finally(() => setSummaryLoading(false));
  }, [paperId, summary, paper, setSummary, setSummaryLoading]);

  if (summaryLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3">
        <SummaryProgressBar />
        <p className="text-[13px] text-muted-foreground">Generating detailed summary...</p>
        <p className="text-[11px] text-muted-foreground/50">This may take 30-60 seconds</p>
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="text-center py-8">
        <p className="text-[13px] text-muted-foreground/60">
          {fetchError ? "Failed to generate summary." : "Summary not available yet."}
        </p>
        <button
          onClick={() => {
            fetchAttempted.current = null;
            setFetchError(false);
            setSummaryLoading(true);
            api
              .getSummary(paperId)
              .then((r) => setSummary(r))
              .catch(() => setFetchError(true))
              .finally(() => setSummaryLoading(false));
          }}
          className="mt-2 text-[12px] font-medium text-foreground hover:opacity-80 transition-opacity"
        >
          {fetchError ? "Retry" : "Generate Summary"}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Overview */}
      {summary.overview && (
        <section>
          <h3 className="text-[13px] font-semibold uppercase tracking-widest text-muted-foreground/70 mb-2">
            Overview
          </h3>
          <Md>{summary.overview}</Md>
        </section>
      )}

      {/* Motivation */}
      {summary.motivation && (
        <section>
          <h3 className="text-[13px] font-semibold uppercase tracking-widest text-muted-foreground/70 mb-2">
            Motivation
          </h3>
          <Md>{summary.motivation}</Md>
        </section>
      )}

      {/* Key Contributions */}
      {summary.key_contributions?.length > 0 && (
        <section>
          <h3 className="text-[13px] font-semibold uppercase tracking-widest text-muted-foreground/70 mb-2">
            Key Contributions
          </h3>
          <ul className="space-y-1.5">
            {summary.key_contributions.map((c, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-[12px] text-muted-foreground/40 shrink-0 mt-0.5">{i + 1}.</span>
                <Md>{c}</Md>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Methodology */}
      {summary.methodology && (
        <section>
          <h3 className="text-[13px] font-semibold uppercase tracking-widest text-muted-foreground/70 mb-2">
            Methodology
          </h3>
          <Md>{summary.methodology}</Md>
        </section>
      )}

      {/* Main Results */}
      {summary.main_results && (
        <section>
          <h3 className="text-[13px] font-semibold uppercase tracking-widest text-muted-foreground/70 mb-2">
            Main Results
          </h3>
          <Md>{summary.main_results}</Md>
        </section>
      )}

      {/* Discussion */}
      {summary.discussion && (
        <section>
          <h3 className="text-[13px] font-semibold uppercase tracking-widest text-muted-foreground/70 mb-2">
            Discussion
          </h3>
          <Md>{summary.discussion}</Md>
        </section>
      )}

      {/* Key Equations */}
      {summary.key_equations?.length > 0 && (
        <section>
          <h3 className="text-[13px] font-semibold uppercase tracking-widest text-muted-foreground/70 mb-2">
            Key Equations
          </h3>
          <div className="space-y-2">
            {summary.key_equations.map((eq, i) => (
              <div key={i} className="rounded-lg bg-accent/50 px-3.5 py-2.5">
                <Md>{eq.equation}</Md>
                <div className="text-[12px] text-muted-foreground mt-1"><Md>{eq.meaning}</Md></div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Key Figures & Tables */}
      {summary.key_figures_and_tables?.length > 0 && (
        <section>
          <h3 className="text-[13px] font-semibold uppercase tracking-widest text-muted-foreground/70 mb-2">
            Key Figures & Tables
          </h3>
          <div className="space-y-1.5">
            {summary.key_figures_and_tables.map((fig, i) => (
              <div key={i} className="rounded-lg bg-accent/50 px-3.5 py-2.5">
                <span className="text-[12px] font-semibold">{fig.id}</span>
                <div className="text-[12px] text-muted-foreground mt-0.5"><Md>{fig.description}</Md></div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Limitations */}
      {summary.limitations?.length > 0 && (
        <section>
          <h3 className="text-[13px] font-semibold uppercase tracking-widest text-muted-foreground/70 mb-2">
            Limitations
          </h3>
          <ul className="space-y-1">
            {summary.limitations.map((l, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-[12px] text-muted-foreground/40 shrink-0">•</span>
                <Md>{l}</Md>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Future Work */}
      {summary.future_work && (
        <section>
          <h3 className="text-[13px] font-semibold uppercase tracking-widest text-muted-foreground/70 mb-2">
            Future Work
          </h3>
          <Md>{summary.future_work}</Md>
        </section>
      )}
    </div>
  );
}
