"use client";

import { useState, useCallback, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import type { FigureInfo, Reference } from "@/lib/api";
import { api } from "@/lib/api";
import { DefinitionPopover } from "./DefinitionPopover";

function parseAuthorNumbers(author: string): { name: string; nums: number[] } {
  const match = author.match(/^(.+?)\s*([\d,\s*†‡§¶]+)$/);
  if (match) {
    const name = match[1].replace(/[,\s]+$/, "").trim();
    const nums = (match[2].match(/\d+/g) || []).map(Number);
    return { name, nums };
  }
  return { name: author.trim(), nums: [] };
}

function parseAffiliationNumber(aff: string): { num: number | null; text: string } {
  const match = aff.match(/^(\d+)\s*[.)\-–—:]\s*(.+)/);
  if (match) return { num: parseInt(match[1]), text: match[2].trim() };
  const match2 = aff.match(/^(\d+)\s+(.+)/);
  if (match2) return { num: parseInt(match2[1]), text: match2[2].trim() };
  return { num: null, text: aff.trim() };
}

interface PaperRendererProps {
  paperId: string;
  title: string;
  authors: string[];
  affiliations: string[];
  abstract: string;
  contentMarkdown: string;
  figures: FigureInfo[];
  references: Reference[];
}

export function PaperRenderer({
  paperId,
  title,
  authors,
  affiliations,
  abstract,
  contentMarkdown,
  figures,
  references,
}: PaperRendererProps) {
  const [popover, setPopover] = useState<{
    term: string;
    context: string;
    position: { x: number; y: number };
  } | null>(null);
  const [refsOpen, setRefsOpen] = useState(false);

  const handleMouseUp = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    const text = selection.toString().trim();
    if (text.length < 2 || text.length > 80 || text.includes("\n")) return;
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const parentEl = range.startContainer.parentElement;
    const context = parentEl?.textContent?.slice(0, 200) || "";
    setPopover({
      term: text,
      context,
      position: { x: Math.min(rect.left, window.innerWidth - 340), y: rect.bottom + 6 },
    });
  }, []);

  const sections = useMemo(() => {
    const lines = contentMarkdown.split("\n");
    const parts: { text: string; afterPage: number }[] = [];
    let current = "";
    let pageEstimate = 0;
    for (const line of lines) {
      if (line.match(/^##\s/)) {
        if (current.trim()) parts.push({ text: current, afterPage: pageEstimate });
        current = line + "\n";
        pageEstimate++;
      } else {
        current += line + "\n";
      }
    }
    if (current.trim()) parts.push({ text: current, afterPage: pageEstimate });
    return parts;
  }, [contentMarkdown]);

  const figuresByPage = useMemo(() => {
    const map = new Map<number, FigureInfo[]>();
    for (const fig of figures) {
      if (!map.has(fig.page)) map.set(fig.page, []);
      map.get(fig.page)!.push(fig);
    }
    return map;
  }, [figures]);

  const figureInsertPoints = useMemo(() => {
    const sortedPages = [...figuresByPage.keys()].sort((a, b) => a - b);
    const insertMap = new Map<number, FigureInfo[]>();
    for (const page of sortedPages) {
      const figs = figuresByPage.get(page)!;
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < sections.length; i++) {
        const dist = Math.abs(sections[i].afterPage - page);
        if (dist < bestDist) { bestDist = dist; bestIdx = i; }
      }
      if (!insertMap.has(bestIdx)) insertMap.set(bestIdx, []);
      insertMap.get(bestIdx)!.push(...figs);
    }
    return insertMap;
  }, [figuresByPage, sections]);

  const figureNumberMap = useMemo(() => {
    const map = new Map<string, number>();
    [...figures].sort((a, b) => a.page - b.page).forEach((fig, idx) => map.set(fig.id, idx + 1));
    return map;
  }, [figures]);

  return (
    <>
      <div className="paper-content" onMouseUp={handleMouseUp}>
        {title && (
          <h1 className="text-[26px] font-bold mb-2 leading-[1.2] tracking-tight" style={{ fontFamily: "'Inter', system-ui, sans-serif" }}>
            {title}
          </h1>
        )}

        {authors.length > 0 && (() => {
          const parsed = authors.map((a) => parseAuthorNumbers(a));
          const hasNumbers = parsed.some((p) => p.nums.length > 0);
          const parsedAffs = affiliations.map((a) => parseAffiliationNumber(a));
          const affsHaveNumbers = parsedAffs.some((a) => a.num !== null);

          return (
            <>
              <p className="text-[14px] text-foreground/75 mb-1 leading-relaxed" style={{ fontFamily: "'Inter', system-ui, sans-serif" }}>
                {parsed.map((p, i) => (
                  <span key={i}>
                    {i > 0 && ", "}
                    {p.name}
                    {hasNumbers && p.nums.length > 0 && (
                      <sup className="text-[10px] text-muted-foreground ml-0.5">{p.nums.join(",")}</sup>
                    )}
                  </span>
                ))}
              </p>

              {affiliations.length > 0 && (
                <div className="text-[12px] text-muted-foreground mb-6 leading-relaxed" style={{ fontFamily: "'Inter', system-ui, sans-serif" }}>
                  {parsedAffs.map((aff, i) => {
                    const num = aff.num ?? (affsHaveNumbers ? null : i + 1);
                    return (
                      <div key={i} className="flex gap-1">
                        {num !== null && (
                          <sup className="text-[9px] text-muted-foreground/60 mt-1 shrink-0">{num}</sup>
                        )}
                        <span className="italic">{aff.text}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          );
        })()}

        {abstract && (
          <div className="mb-10 py-4 px-5 bg-accent/60 rounded-lg border border-border/50 text-[14px] leading-[1.75]">
            <p className="font-semibold text-[11px] mb-2 text-muted-foreground uppercase tracking-widest" style={{ fontFamily: "'Inter', system-ui, sans-serif" }}>
              Abstract
            </p>
            <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
              {abstract}
            </ReactMarkdown>
          </div>
        )}

        <div className="text-[15px] leading-[1.8]">
          {sections.map((section, idx) => (
            <div key={idx}>
              <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
                {section.text}
              </ReactMarkdown>

              {figureInsertPoints.has(idx) && (
                <div className="my-8 space-y-5">
                  {figureInsertPoints.get(idx)!.map((fig) => (
                    <figure key={fig.id} className="rounded-lg overflow-hidden border bg-card shadow-sm">
                      <div className="p-3">
                        <img
                          src={api.getFigureUrl(paperId, fig.id)}
                          alt={`Figure ${figureNumberMap.get(fig.id) ?? ""}`}
                          className="max-w-full mx-auto rounded"
                          loading="lazy"
                        />
                      </div>
                      <figcaption className="px-4 py-2.5 text-[12px] text-muted-foreground border-t bg-accent/30" style={{ fontFamily: "'Inter', system-ui, sans-serif" }}>
                        <span className="font-semibold text-foreground/70">
                          Figure {figureNumberMap.get(fig.id) ?? ""}
                        </span>
                        {fig.caption && <span>. {fig.caption}</span>}
                      </figcaption>
                    </figure>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        {references.length > 0 && (
          <div className="mt-10 pt-6 border-t">
            <button
              onClick={() => setRefsOpen(!refsOpen)}
              className="flex items-center gap-2.5 w-full text-left group"
              style={{ fontFamily: "'Inter', system-ui, sans-serif" }}
            >
              <svg
                className={`w-3 h-3 text-muted-foreground/60 transition-transform duration-200 ${refsOpen ? "rotate-90" : ""}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2.5}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
              <span className="text-[13px] font-semibold text-foreground/70 uppercase tracking-widest">
                References
              </span>
              <span className="text-[12px] text-muted-foreground/50 font-medium">
                {references.length}
              </span>
            </button>

            {refsOpen && (
              <ol className="mt-4 space-y-1 list-none pl-0 animate-fade-in">
                {references.map((ref) => (
                  <li key={ref.id} className="flex gap-2.5 text-[12.5px] text-muted-foreground leading-relaxed py-0.5">
                    <span className="text-foreground/40 shrink-0 w-6 text-right tabular-nums font-medium" style={{ fontFamily: "'Inter', system-ui, sans-serif" }}>
                      {ref.id}.
                    </span>
                    <span>{ref.text}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </div>

      {popover && (
        <DefinitionPopover
          paperId={paperId}
          term={popover.term}
          context={popover.context}
          position={popover.position}
          onClose={() => setPopover(null)}
        />
      )}
    </>
  );
}
