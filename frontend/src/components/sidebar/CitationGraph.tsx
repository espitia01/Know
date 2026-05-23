"use client";

import { useCallback, useMemo, useState } from "react";
import type { CitedByItem, PriorWork } from "@/lib/api";
import { extractCitationShortLabel } from "@/lib/formatBibliography";
import { priorWorkExternalHref, referenceIndexLabel } from "@/lib/priorWorkLinks";

/**
 * Citation map for the Related pane: references this paper cites (left) and
 * papers that cite it (right). Deliberately minimal — orientation, not analytics.
 */

const MAX_PER_SIDE = 24;
const VIEW_W = 520;
const VIEW_H = 300;
const CENTER_X = VIEW_W / 2;
const CENTER_Y = VIEW_H / 2;
const LEFT_X = 88;
const RIGHT_X = VIEW_W - 88;
const NODE_H = 22;
const NODE_GAP = 6;

interface GraphNode {
  id: string;
  label: string;
  sublabel: string;
  href: string | null;
  direction: "outbound" | "inbound";
  index?: number;
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
  const title = (item.title || "Citing paper").slice(0, 42);
  if (authors) return `${authors}${year}`;
  return `${title}${year}`;
}

function shortPaperTitle(title: string, max = 36): string {
  const t = (title || "This paper").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function stackY(count: number, index: number): number {
  const totalH = count * NODE_H + (count - 1) * NODE_GAP;
  const startY = CENTER_Y - totalH / 2 + NODE_H / 2;
  return startY + index * (NODE_H + NODE_GAP);
}

interface CitationGraphProps {
  paperTitle: string;
  outbound: PriorWork[];
  inbound: CitedByItem[];
  onHoverIndex?: (entry: { direction: "outbound" | "inbound"; index: number } | null) => void;
}

export function CitationGraph({
  paperTitle,
  outbound,
  inbound,
  onHoverIndex,
}: CitationGraphProps) {
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const { outboundNodes, inboundNodes } = useMemo(() => {
    const o: GraphNode[] = outbound.slice(0, MAX_PER_SIDE).map((w, i) => {
      const raw = w.citation_display || w.title || "";
      return {
        id: nodeIdForPrior(w, i),
        label: extractCitationShortLabel(raw),
        sublabel: `[${referenceIndexLabel(w, i + 1)}]`,
        href: priorWorkExternalHref(w),
        direction: "outbound" as const,
        index: referenceIndexLabel(w, i + 1),
      };
    });
    const inn: GraphNode[] = inbound.slice(0, MAX_PER_SIDE).map((c, i) => ({
      id: nodeIdForCited(c, i),
      label: citedByLabel(c),
      sublabel: "Cites this paper",
      href: citedByHref(c),
      direction: "inbound" as const,
      index: i + 1,
    }));
    return { outboundNodes: o, inboundNodes: inn };
  }, [outbound, inbound]);

  const layout = useMemo(() => {
    const outbound = outboundNodes.map((n, i) => ({
      ...n,
      x: LEFT_X,
      y: stackY(outboundNodes.length, i),
    }));
    const inbound = inboundNodes.map((n, i) => ({
      ...n,
      x: RIGHT_X,
      y: stackY(inboundNodes.length, i),
    }));
    return { outbound, inbound };
  }, [outboundNodes, inboundNodes]);

  const handleEnter = useCallback(
    (n: GraphNode) => {
      setFocusedId(n.id);
      if (typeof n.index === "number") {
        onHoverIndex?.({ direction: n.direction, index: n.index });
      }
    },
    [onHoverIndex],
  );
  const handleLeave = useCallback(() => {
    setFocusedId(null);
    onHoverIndex?.(null);
  }, [onHoverIndex]);

  const omitted =
    Math.max(0, outbound.length - MAX_PER_SIDE) + Math.max(0, inbound.length - MAX_PER_SIDE);

  return (
    <div className="rounded-lg border border-border/50 bg-card/30">
      <div className="border-b border-border/40 px-4 py-3">
        <h3 className="font-display text-[var(--text-sm)] font-semibold tracking-[-0.02em] text-foreground">
          Citation map
        </h3>
        <p className="mt-1 text-[var(--text-xs)] leading-relaxed text-muted-foreground/85">
          Left: references listed in this paper&apos;s bibliography ({outbound.length}). Center: the
          paper you are reading. Right: later papers that cite it ({inbound.length}), from Semantic
          Scholar when available.
        </p>
      </div>

      <svg
        role="img"
        aria-label="Citation map showing bibliography references and citing papers"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="mx-auto block w-full max-w-[540px] px-2 py-3"
      >
        {/* Column guides */}
        <text x={LEFT_X} y={18} textAnchor="middle" className="fill-muted-foreground text-[9px] font-medium uppercase tracking-wider">
          References cited
        </text>
        <text x={RIGHT_X} y={18} textAnchor="middle" className="fill-muted-foreground text-[9px] font-medium uppercase tracking-wider">
          Cited by
        </text>

        {/* Edges */}
        <g stroke="currentColor" className="text-border/70">
          {layout.outbound.map((n) => (
            <line
              key={`e-out-${n.id}`}
              x1={CENTER_X - 36}
              y1={CENTER_Y}
              x2={LEFT_X + 70}
              y2={n.y}
              strokeWidth={focusedId === n.id ? 1.4 : 0.9}
              className="motion-safe:transition-[stroke-width] motion-safe:duration-150"
            />
          ))}
          {layout.inbound.map((n) => (
            <line
              key={`e-in-${n.id}`}
              x1={CENTER_X + 36}
              y1={CENTER_Y}
              x2={RIGHT_X - 70}
              y2={n.y}
              strokeWidth={focusedId === n.id ? 1.4 : 0.9}
              className="motion-safe:transition-[stroke-width] motion-safe:duration-150"
            />
          ))}
        </g>

        {/* Center node */}
        <g>
          <rect
            x={CENTER_X - 72}
            y={CENTER_Y - 22}
            width={144}
            height={44}
            rx={8}
            className="fill-foreground/90 stroke-background"
            strokeWidth={1.5}
          />
          <text x={CENTER_X} y={CENTER_Y - 4} textAnchor="middle" className="fill-background text-[9px] font-semibold uppercase tracking-wide">
            This paper
          </text>
          <text x={CENTER_X} y={CENTER_Y + 12} textAnchor="middle" className="fill-background text-[10px] font-medium">
            {shortPaperTitle(paperTitle)}
          </text>
        </g>

        {/* Side nodes */}
        {[...layout.outbound, ...layout.inbound].map((n) => {
          const isLeft = n.direction === "outbound";
          const w = 140;
          const x = isLeft ? LEFT_X - w / 2 : RIGHT_X - w / 2;
          const isFocused = focusedId === n.id;
          const inner = (
            <>
              <rect
                x={x}
                y={n.y - NODE_H / 2}
                width={w}
                height={NODE_H}
                rx={5}
                className={isFocused ? "fill-card stroke-foreground/30" : "fill-muted/[0.12] stroke-border/60"}
                strokeWidth={1}
              />
              <text
                x={isLeft ? x + 6 : x + w - 6}
                y={n.y + 1}
                textAnchor={isLeft ? "start" : "end"}
                dominantBaseline="middle"
                className="fill-foreground text-[9px] font-medium"
              >
                {n.label.length > 34 ? `${n.label.slice(0, 33)}…` : n.label}
              </text>
            </>
          );
          const handlers = {
            onMouseEnter: () => handleEnter(n),
            onMouseLeave: handleLeave,
            onFocus: () => handleEnter(n),
            onBlur: handleLeave,
          };
          if (n.href) {
            return (
              <a
                key={n.id}
                href={n.href}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`${n.direction === "outbound" ? "Reference" : "Citing paper"}: ${n.label}`}
                {...handlers}
              >
                {inner}
              </a>
            );
          }
          return (
            <g key={n.id} role="img" aria-label={n.label} {...handlers}>
              {inner}
            </g>
          );
        })}
      </svg>

      {omitted > 0 && (
        <p className="border-t border-border/40 px-4 py-2 text-center text-[10px] text-muted-foreground/75">
          Showing {MAX_PER_SIDE} per side · {omitted} more in the lists below
        </p>
      )}
    </div>
  );
}
