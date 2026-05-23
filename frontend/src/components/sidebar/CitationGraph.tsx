"use client";

import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { CitedByItem, PriorWork } from "@/lib/api";
import { extractCitationShortLabel } from "@/lib/formatBibliography";
import { priorWorkExternalHref, referenceIndexLabel } from "@/lib/priorWorkLinks";

const PREVIEW = 5;

interface CitationEntry {
  id: string;
  label: string;
  sublabel: string;
  href: string | null;
  direction: "outbound" | "inbound";
}

function nodeIdForPrior(work: PriorWork, fallback: number): string {
  return (
    work.doi?.trim() ||
    work.arxiv?.trim() ||
    work.ref_id?.trim() ||
    work.bib_label?.trim() ||
    `ref-${fallback}`
  );
}

function nodeIdForCited(item: CitedByItem, fallback: number): string {
  return item.s2_id?.trim() || item.doi?.trim() || `cite-${fallback}`;
}

function citedByHref(item: CitedByItem): string | null {
  if (item.doi) return `https://doi.org/${item.doi}`;
  if (item.arxiv) return `https://arxiv.org/abs/${item.arxiv}`;
  if (item.url) return item.url;
  if (item.s2_id) return `https://www.semanticscholar.org/paper/${item.s2_id}`;
  return null;
}

function citedByLabel(item: CitedByItem): string {
  const authors = (item.authors ?? []).slice(0, 2).join(", ");
  const year = item.year ? ` (${item.year})` : "";
  if (authors) return `${authors}${year}`;
  return `${(item.title || "Citing paper").slice(0, 56)}${year}`;
}

function shortPaperTitle(title: string, max = 48): string {
  const t = (title || "This paper").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function buildOutbound(outbound: PriorWork[]): CitationEntry[] {
  return outbound.map((w, i) => {
    const raw = w.citation_display || w.title || "";
    return {
      id: nodeIdForPrior(w, i),
      label: extractCitationShortLabel(raw),
      sublabel: `[${referenceIndexLabel(w, i + 1)}]`,
      href: priorWorkExternalHref(w),
      direction: "outbound" as const,
    };
  });
}

function buildInbound(inbound: CitedByItem[]): CitationEntry[] {
  return inbound.map((c, i) => ({
    id: nodeIdForCited(c, i),
    label: citedByLabel(c),
    sublabel: "Cites this paper",
    href: citedByHref(c),
    direction: "inbound" as const,
  }));
}

function CitationChip({ entry }: { entry: CitationEntry }) {
  const cls =
    "block rounded-md border border-border/50 bg-muted/[0.08] px-2 py-1.5 text-left transition-colors motion-safe:duration-150 hover:bg-muted/[0.14] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
  const inner = (
    <>
      <span className="block text-[var(--text-xs)] font-medium leading-snug text-foreground/90 line-clamp-2">
        {entry.label}
      </span>
      <span className="mt-0.5 block text-[10px] text-muted-foreground/75">{entry.sublabel}</span>
    </>
  );
  if (entry.href) {
    return (
      <a href={entry.href} target="_blank" rel="noopener noreferrer" className={cls}>
        {inner}
      </a>
    );
  }
  return <div className={cls}>{inner}</div>;
}

function ColumnPreview({
  title,
  count,
  entries,
  emptyHint,
}: {
  title: string;
  count: number;
  entries: CitationEntry[];
  emptyHint: string;
}) {
  const preview = entries.slice(0, PREVIEW);
  const rest = entries.length - preview.length;

  return (
    <div className="min-w-0 flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-[var(--text-xs)] font-semibold uppercase tracking-wide text-muted-foreground/80">
          {title}
        </h4>
        <span className="shrink-0 rounded-full border border-border/40 bg-muted/[0.08] px-2 py-0.5 text-[10px] tabular-nums font-medium text-muted-foreground">
          {count}
        </span>
      </div>
      {preview.length === 0 ? (
        <p className="text-[var(--text-xs)] leading-relaxed text-muted-foreground/75">{emptyHint}</p>
      ) : (
        <div className="space-y-1.5">
          {preview.map((e) => (
            <CitationChip key={e.id} entry={e} />
          ))}
          {rest > 0 && (
            <p className="text-[10px] text-muted-foreground/70">+ {rest} more below</p>
          )}
        </div>
      )}
    </div>
  );
}

function ExpandedMapDialog({
  paperTitle,
  outbound,
  inbound,
  onClose,
}: {
  paperTitle: string;
  outbound: CitationEntry[];
  inbound: CitationEntry[];
  onClose: () => void;
}) {
  return createPortal(
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal
      aria-label="Expanded citation map"
      onClick={onClose}
    >
      <div
        className="flex max-h-[min(88vh,720px)] w-full max-w-3xl flex-col overflow-hidden rounded-[var(--radius-lg)] border border-border/50 bg-popover shadow-[var(--shadow-sm)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border/40 px-5 py-4">
          <div>
            <h2 className="font-display text-[var(--text-base)] font-semibold tracking-[-0.02em]">
              Citation map
            </h2>
            <p className="mt-1 text-[var(--text-xs)] text-muted-foreground/85">
              {shortPaperTitle(paperTitle, 72)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-[var(--text-sm)] text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 sm:grid-cols-2 sm:divide-x sm:divide-border/40">
          <div className="min-h-0 overflow-y-auto px-5 py-4">
            <p className="mb-3 text-[var(--text-xs)] font-semibold text-foreground">
              References cited ({outbound.length})
            </p>
            <div className="space-y-1.5">
              {outbound.map((e) => (
                <CitationChip key={e.id} entry={e} />
              ))}
              {outbound.length === 0 && (
                <p className="text-[var(--text-xs)] text-muted-foreground/75">No bibliography parsed.</p>
              )}
            </div>
          </div>
          <div className="min-h-0 overflow-y-auto border-t border-border/40 px-5 py-4 sm:border-t-0">
            <p className="mb-3 text-[var(--text-xs)] font-semibold text-foreground">
              Cited by ({inbound.length})
            </p>
            <div className="space-y-1.5">
              {inbound.map((e) => (
                <CitationChip key={e.id} entry={e} />
              ))}
              {inbound.length === 0 && (
                <p className="text-[var(--text-xs)] text-muted-foreground/75">
                  No citing papers from Semantic Scholar yet.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

interface CitationGraphProps {
  paperTitle: string;
  outbound: PriorWork[];
  inbound: CitedByItem[];
}

export function CitationGraph({ paperTitle, outbound, inbound }: CitationGraphProps) {
  const [expanded, setExpanded] = useState(false);

  const outboundEntries = useMemo(() => buildOutbound(outbound), [outbound]);
  const inboundEntries = useMemo(() => buildInbound(inbound), [inbound]);

  const canExpand = outboundEntries.length > 0 || inboundEntries.length > 0;

  return (
    <>
      <div className="rounded-lg border border-border/50 bg-card/30 dark:bg-card/22">
        <div className="flex items-start justify-between gap-3 border-b border-border/40 px-4 py-3">
          <div>
            <h3 className="font-display text-[var(--text-sm)] font-semibold tracking-[-0.02em] text-foreground">
              Citation map
            </h3>
            <p className="mt-1 text-[var(--text-xs)] leading-relaxed text-muted-foreground/85">
              What this paper cites and what cites it — scroll the lists below for full entries.
            </p>
          </div>
          {canExpand && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="shrink-0 rounded-md border border-border/50 px-2.5 py-1 text-[var(--text-xs)] font-medium text-foreground/90 transition-colors motion-safe:duration-150 hover:bg-muted/[0.08] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              Expand
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-[1fr_auto_1fr] sm:items-start sm:gap-3">
          <ColumnPreview
            title="References cited"
            count={outbound.length}
            entries={outboundEntries}
            emptyHint="Run Prepare to extract the bibliography."
          />

          <div className="hidden sm:flex flex-col items-center justify-center px-1 pt-6">
            <div
              className="h-full w-px min-h-[48px] bg-border/60"
              aria-hidden
            />
            <div className="my-2 rounded-lg border border-border/50 bg-muted/[0.08] px-3 py-2 text-center max-w-[148px]">
              <p className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground/80">
                This paper
              </p>
              <p className="mt-1 text-[11px] font-medium leading-snug text-foreground line-clamp-3">
                {shortPaperTitle(paperTitle)}
              </p>
            </div>
            <div className="h-full w-px min-h-[48px] bg-border/60" aria-hidden />
          </div>

          <div className="sm:hidden rounded-lg border border-border/40 bg-muted/[0.06] px-3 py-2 text-center">
            <p className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground/80">
              This paper
            </p>
            <p className="mt-0.5 text-[11px] font-medium text-foreground">{shortPaperTitle(paperTitle, 64)}</p>
          </div>

          <ColumnPreview
            title="Cited by"
            count={inbound.length}
            entries={inboundEntries}
            emptyHint="Semantic Scholar has no citing papers yet."
          />
        </div>
      </div>

      {expanded && (
        <ExpandedMapDialog
          paperTitle={paperTitle}
          outbound={outboundEntries}
          inbound={inboundEntries}
          onClose={() => setExpanded(false)}
        />
      )}
    </>
  );
}
