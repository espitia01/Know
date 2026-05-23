"use client";

import { useMemo } from "react";
import type { CitedByItem, PriorWork, PriorWorkTopic } from "@/lib/api";
import {
  filterUsablePriorWork,
  isUsableClusterTheme,
  sanitizeRelatedClusterSummaryMarkdown,
} from "@/lib/formatBibliography";

interface CitationGraphProps {
  paperTitle: string;
  outbound: PriorWork[];
  inbound: CitedByItem[];
  topics?: PriorWorkTopic[];
}

function shortPaperTitle(title: string, max = 56): string {
  const t = (title || "This paper").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function CitationGraph({
  paperTitle,
  outbound,
  inbound,
  topics = [],
}: CitationGraphProps) {
  const cleanOutbound = useMemo(() => filterUsablePriorWork(outbound), [outbound]);

  const themeCards = useMemo(() => {
    return topics
      .map((t) => {
        const theme = (t.theme || "").trim();
        if (!isUsableClusterTheme(theme)) return null;
        const items = filterUsablePriorWork(t.items ?? []);
        if (items.length === 0) return null;
        const summary = sanitizeRelatedClusterSummaryMarkdown(t.summary || "");
        return {
          theme,
          count: items.length,
          summary: summary.length >= 40 ? summary : null,
        };
      })
      .filter(Boolean) as { theme: string; count: number; summary: string | null }[];
  }, [topics]);

  const inboundYears = useMemo(() => {
    const yrs = inbound.map((c) => c.year).filter((y): y is number => typeof y === "number");
    if (!yrs.length) return null;
    return { min: Math.min(...yrs), max: Math.max(...yrs) };
  }, [inbound]);

  if (cleanOutbound.length === 0 && inbound.length === 0 && themeCards.length === 0) {
    return null;
  }

  return (
    <div className="rounded-lg border border-border/50 bg-card/30 dark:bg-card/22">
      <div className="border-b border-border/40 px-4 py-3">
        <h3 className="font-display text-[var(--text-sm)] font-semibold tracking-[-0.02em] text-foreground">
          Citation landscape
        </h3>
        <p className="mt-1 text-[var(--text-xs)] leading-relaxed text-muted-foreground/85">
          How this paper sits in its field — not a duplicate of the bibliography below.
        </p>
      </div>

      <div className="grid gap-3 p-4 sm:grid-cols-3">
        <div className="rounded-md border border-border/40 bg-muted/[0.06] px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/80">
            Bibliography
          </p>
          <p className="mt-1 font-display text-[var(--text-lg)] font-semibold tabular-nums text-foreground">
            {cleanOutbound.length}
          </p>
          <p className="text-[10px] text-muted-foreground/75">parsed references</p>
        </div>
        <div className="rounded-md border border-border/40 bg-muted/[0.06] px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/80">
            Cited by
          </p>
          <p className="mt-1 font-display text-[var(--text-lg)] font-semibold tabular-nums text-foreground">
            {inbound.length}
          </p>
          <p className="text-[10px] text-muted-foreground/75">
            {inboundYears
              ? `publications ${inboundYears.min}–${inboundYears.max}`
              : "from Semantic Scholar"}
          </p>
        </div>
        <div className="rounded-md border border-border/40 bg-muted/[0.06] px-3 py-2.5 sm:col-span-1">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/80">
            This paper
          </p>
          <p className="mt-1 text-[var(--text-xs)] font-medium leading-snug text-foreground line-clamp-3">
            {shortPaperTitle(paperTitle)}
          </p>
        </div>
      </div>

      {themeCards.length > 0 && (
        <div className="border-t border-border/40 px-4 py-3 space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/80">
            Thematic clusters
          </p>
          <div className="space-y-2">
            {themeCards.map((card) => (
              <div
                key={card.theme}
                className="rounded-md border border-border/40 bg-muted/[0.04] px-3 py-2"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-[var(--text-xs)] font-medium text-foreground">{card.theme}</p>
                  <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/75">
                    {card.count} ref{card.count === 1 ? "" : "s"}
                  </span>
                </div>
                {card.summary && (
                  <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground/80 line-clamp-3">
                    {card.summary}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
