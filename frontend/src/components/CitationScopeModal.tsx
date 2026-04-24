"use client";

import { useEffect, useMemo, useState } from "react";

export interface CitationScopePaper {
  id: string;
  title: string;
}

interface CitationScopeModalProps {
  open: boolean;
  onClose: () => void;
  papers: CitationScopePaper[];
  activePaperId?: string;
  workspaceName?: string | null;
  onExport: (paperIds: string[], label: string) => void;
}

/**
 * Pre-export picker that appears when a paper reader session contains
 * more than one paper. Lets the user decide whether to export BibTeX
 * for the paper they're actively reading, for every paper in the
 * session, or for any subset in between — previously the "Citations"
 * button silently defaulted to the active paper, which was confusing
 * when people were clearly looking at a multi-paper workspace.
 *
 * Keeping this as a distinct lightweight modal avoids bloating the
 * existing `BibtexModal` and lets the BibTeX render stay a pure
 * "given these IDs, show the output" step.
 */
export function CitationScopeModal({
  open,
  onClose,
  papers,
  activePaperId,
  workspaceName,
  onExport,
}: CitationScopeModalProps) {
  // Default selection: all papers in the session. Most people hitting
  // this button from a workspace want "export everything"; deselecting
  // is cheaper than remembering to select the full set.
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    setSelected(new Set(papers.map((p) => p.id)));
  }, [open, papers]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const count = selected.size;
  const allSelected = count === papers.length && papers.length > 0;
  const noneSelected = count === 0;

  const selectedLabel = useMemo(() => {
    if (allSelected) return workspaceName ? `All papers in ${workspaceName}` : "All papers in session";
    if (count === 1) {
      const only = papers.find((p) => selected.has(p.id));
      return only ? only.title : "1 paper";
    }
    return `${count} papers`;
  }, [allSelected, count, papers, selected, workspaceName]);

  if (!open) return null;

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(papers.map((p) => p.id)));
  const selectNone = () => setSelected(new Set());
  const selectCurrent = () => {
    if (activePaperId) setSelected(new Set([activePaperId]));
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label="Select papers for citation export"
    >
      <div className="absolute inset-0 bg-foreground/25 backdrop-blur-md" onClick={onClose} />
      <div className="relative glass-strong rounded-2xl shadow-xl w-full max-w-md mx-4 flex flex-col max-h-[80vh] animate-fade-in">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div>
            <h3 className="text-[14px] font-semibold text-foreground">Export Citations</h3>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Pick which papers to include.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-7 h-7 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent flex items-center justify-center transition-colors ring-focus"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-3 border-b border-border flex items-center gap-2 text-[11px]">
          <button
            onClick={selectAll}
            className="px-2 py-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors ring-focus"
          >
            Select all
          </button>
          <button
            onClick={selectNone}
            className="px-2 py-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors ring-focus"
          >
            Select none
          </button>
          {activePaperId && (
            <button
              onClick={selectCurrent}
              className="px-2 py-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/60 transition-colors ring-focus"
            >
              Current paper only
            </button>
          )}
          <span className="ml-auto text-muted-foreground">
            {count}/{papers.length}
          </span>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-2">
          {papers.length === 0 ? (
            <p className="text-[12px] text-muted-foreground text-center py-8">
              No papers in session.
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {papers.map((p) => {
                const checked = selected.has(p.id);
                const isActive = p.id === activePaperId;
                return (
                  <li key={p.id}>
                    <label
                      className={`flex items-start gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                        checked ? "bg-accent/50" : "hover:bg-accent/30"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(p.id)}
                        className="mt-0.5 w-3.5 h-3.5 accent-foreground cursor-pointer"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-[12px] text-foreground line-clamp-2 leading-snug">
                          {p.title}
                        </p>
                        {isActive && (
                          <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
                            Currently reading
                          </span>
                        )}
                      </div>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="px-5 py-3 border-t border-border flex items-center justify-between gap-2">
          <p className="text-[11px] text-muted-foreground truncate flex-1" title={selectedLabel}>
            {noneSelected ? "Select at least one paper." : selectedLabel}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="text-[12px] text-muted-foreground hover:text-foreground px-3 py-1.5 rounded-lg transition-colors ring-focus"
            >
              Cancel
            </button>
            <button
              disabled={noneSelected}
              onClick={() => {
                const ids = papers
                  .map((p) => p.id)
                  .filter((id) => selected.has(id));
                onExport(ids, selectedLabel);
              }}
              className="text-[12px] font-semibold px-4 py-1.5 rounded-xl btn-primary-glass disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Export {count > 0 ? `(${count})` : ""}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
