"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { CitedByItem, PriorWork } from "@/lib/api";
import { priorWorkExternalHref, referenceIndexLabel } from "@/lib/priorWorkLinks";

/**
 * Small interactive citation graph for the Related pane. Center node is the
 * current paper; outbound (Prepare's prior_work) fans out on the left arc,
 * inbound (Cited-by) fans out on the right arc. Hand-rolled SVG — no graph
 * library, no new design tokens.
 */

const MAX_PER_SIDE = 30;
const VIEW_W = 360;
const VIEW_H = 340;
const CENTER_X = VIEW_W / 2;
const CENTER_Y = VIEW_H / 2;
const CENTER_RADIUS = 12;
const NODE_RADIUS = 6;

interface GraphNode {
  id: string;
  label: string;
  detail: string;
  href: string | null;
  direction: "self" | "outbound" | "inbound";
  /** 1-indexed position in source list (for label alignment with the flat list). */
  index?: number;
}

function nodeIdForPrior(work: PriorWork, fallback: number): string {
  return (
    work.doi?.trim() ||
    work.arxiv?.trim() ||
    work.ref_id?.trim() ||
    work.bib_label?.trim() ||
    `${work.title?.slice(0, 32) ?? "ref"}-${fallback}`
  );
}

function nodeIdForCited(item: CitedByItem, fallback: number): string {
  return (
    item.s2_id?.trim() ||
    item.doi?.trim() ||
    item.arxiv?.trim() ||
    `${item.title?.slice(0, 32) ?? "cite"}-${fallback}`
  );
}

function citedByHref(item: CitedByItem): string | null {
  if (item.doi) return `https://doi.org/${item.doi}`;
  if (item.arxiv) return `https://arxiv.org/abs/${item.arxiv}`;
  if (item.url) return item.url;
  if (item.s2_id) return `https://www.semanticscholar.org/paper/${item.s2_id}`;
  return null;
}

function shortLabel(s: string, max = 40): string {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Deterministic point on a circular arc. Inputs in radians. */
function arcPoint(cx: number, cy: number, r: number, angle: number): { x: number; y: number } {
  return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
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
  const svgRef = useRef<SVGSVGElement>(null);

  // Build node lists. The fact that we slice to MAX_PER_SIDE here means the
  // graph is for orientation — the flat list below the graph stays the
  // authoritative source for exhaustive citation accounting.
  const { outboundNodes, inboundNodes } = useMemo(() => {
    const o: GraphNode[] = outbound.slice(0, MAX_PER_SIDE).map((w, i) => ({
      id: nodeIdForPrior(w, i),
      label: shortLabel(w.title || w.citation_display || w.ref_id || `Ref ${i + 1}`, 36),
      detail: w.citation_display || w.title || "Reference",
      href: priorWorkExternalHref(w),
      direction: "outbound",
      index: referenceIndexLabel(w, i + 1),
    }));
    const ino: GraphNode[] = inbound.slice(0, MAX_PER_SIDE).map((c, i) => ({
      id: nodeIdForCited(c, i),
      label: shortLabel(c.title || "Citing paper", 36),
      detail: c.title || "Citing paper",
      href: citedByHref(c),
      direction: "inbound",
      index: i + 1,
    }));
    return { outboundNodes: o, inboundNodes: ino };
  }, [outbound, inbound]);

  // Concentric deterministic layout: outbound on the left arc, inbound on
  // the right arc. Both arcs share the same radius so neither side feels
  // visually heavier when one list is much longer than the other.
  const layout = useMemo(() => {
    const radius = Math.min(VIEW_W, VIEW_H) * 0.42;
    const outboundStart = (Math.PI * 110) / 180;
    const outboundEnd = (Math.PI * 250) / 180;
    const inboundStart = (Math.PI * 290) / 180;
    const inboundEnd = (Math.PI * (360 + 70)) / 180;
    function place(nodes: GraphNode[], start: number, end: number) {
      if (nodes.length === 0) return [] as Array<GraphNode & { x: number; y: number }>;
      const span = end - start;
      const step = nodes.length === 1 ? 0 : span / (nodes.length - 1);
      return nodes.map((n, i) => {
        const angle = nodes.length === 1 ? (start + end) / 2 : start + step * i;
        return { ...n, ...arcPoint(CENTER_X, CENTER_Y, radius, angle) };
      });
    }
    return {
      outbound: place(outboundNodes, outboundStart, outboundEnd),
      inbound: place(inboundNodes, inboundStart, inboundEnd),
    };
  }, [outboundNodes, inboundNodes]);

  const handleEnter = useCallback(
    (n: GraphNode) => {
      setFocusedId(n.id);
      if (n.direction !== "self" && typeof n.index === "number") {
        onHoverIndex?.({ direction: n.direction, index: n.index });
      }
    },
    [onHoverIndex],
  );
  const handleLeave = useCallback(() => {
    setFocusedId(null);
    onHoverIndex?.(null);
  }, [onHoverIndex]);

  const totalOmitted =
    Math.max(0, outbound.length - MAX_PER_SIDE) + Math.max(0, inbound.length - MAX_PER_SIDE);

  return (
    <div className="relative w-full overflow-hidden rounded-lg border border-border/55 bg-card/30 px-2 py-3">
      <svg
        ref={svgRef}
        role="img"
        aria-label="Citation graph: outbound and inbound papers"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="mx-auto block w-full max-w-[420px]"
      >
        {/* Edges first so nodes paint on top. */}
        <g>
          {layout.outbound.map((n) => (
            <line
              key={`edge-out-${n.id}`}
              x1={CENTER_X}
              y1={CENTER_Y}
              x2={n.x}
              y2={n.y}
              data-action="explain"
              stroke="rgb(var(--highlight-rgb) / 0.45)"
              strokeWidth={focusedId === n.id ? 1.6 : 0.9}
              className="motion-safe:transition-[stroke-width] motion-safe:duration-150"
            />
          ))}
          {layout.inbound.map((n) => (
            <line
              key={`edge-in-${n.id}`}
              x1={CENTER_X}
              y1={CENTER_Y}
              x2={n.x}
              y2={n.y}
              data-action="followup"
              stroke="rgb(var(--highlight-rgb) / 0.45)"
              strokeWidth={focusedId === n.id ? 1.6 : 0.9}
              className="motion-safe:transition-[stroke-width] motion-safe:duration-150"
            />
          ))}
        </g>

        {/* Center node. */}
        <g>
          <circle
            cx={CENTER_X}
            cy={CENTER_Y}
            r={CENTER_RADIUS}
            className="fill-foreground/85 stroke-background"
            strokeWidth={1.5}
          />
          <text
            x={CENTER_X}
            y={CENTER_Y + CENTER_RADIUS + 14}
            textAnchor="middle"
            className="fill-foreground text-[10px] font-medium"
          >
            {shortLabel(paperTitle || "This paper", 32)}
          </text>
        </g>

        {/* Outbound + inbound nodes. */}
        {[...layout.outbound, ...layout.inbound].map((n) => {
          const isFocused = focusedId === n.id;
          const handlers = {
            tabIndex: 0,
            onFocus: () => handleEnter(n),
            onBlur: handleLeave,
            onMouseEnter: () => handleEnter(n),
            onMouseLeave: handleLeave,
            className: "focus:outline-none cursor-pointer",
          } as const;
          const inner = (
            <>
              <circle
                cx={n.x}
                cy={n.y}
                r={isFocused ? NODE_RADIUS + 1.5 : NODE_RADIUS}
                data-action={n.direction === "outbound" ? "explain" : "followup"}
                fill="rgb(var(--highlight-rgb) / 0.85)"
                stroke="rgb(var(--highlight-rgb))"
                strokeWidth={1.2}
                className="motion-safe:transition-[r] motion-safe:duration-150"
              />
              {isFocused && (
                <g>
                  <rect
                    x={n.x - 80}
                    y={n.y + NODE_RADIUS + 3}
                    width={160}
                    height={22}
                    rx={4}
                    className="fill-popover stroke-border/60"
                    strokeWidth={0.5}
                  />
                  <text
                    x={n.x}
                    y={n.y + NODE_RADIUS + 18}
                    textAnchor="middle"
                    className="fill-foreground text-[10px]"
                  >
                    {n.label}
                  </text>
                </g>
              )}
            </>
          );
          if (n.href) {
            return (
              <a
                key={`node-${n.id}`}
                href={n.href}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`${n.direction} citation: ${n.detail}`}
                {...handlers}
              >
                {inner}
              </a>
            );
          }
          return (
            <g
              key={`node-${n.id}`}
              role="button"
              aria-label={`${n.direction} citation: ${n.detail}`}
              {...handlers}
            >
              {inner}
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex items-center justify-between px-1 text-[10px] text-muted-foreground/80">
        <span>
          <span className="mr-1 inline-block h-2 w-2 rounded-full" data-action="explain" style={{ background: "rgb(var(--highlight-rgb) / 0.85)" }} />
          Outbound · {outbound.length}
        </span>
        <span>
          Inbound · {inbound.length}
          <span className="ml-1 inline-block h-2 w-2 rounded-full" data-action="followup" style={{ background: "rgb(var(--highlight-rgb) / 0.85)" }} />
        </span>
      </div>
      {totalOmitted > 0 && (
        <p className="mt-1 text-center text-[10px] text-muted-foreground/70">
          + {totalOmitted} more in the list below
        </p>
      )}
    </div>
  );
}
