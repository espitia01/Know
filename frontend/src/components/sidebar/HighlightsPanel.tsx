"use client";

import { useMemo, useState } from "react";
import { api, type Highlight } from "@/lib/api";
import { useStore, EMPTY_HIGHLIGHTS_LIST, EMPTY_PDF_REGIONS_LIST } from "@/lib/store";
import { isPersistedHighlight } from "@/lib/highlightUtils";
import { formatHighlightDisplay } from "@/lib/highlightDisplay";
import { EmptyState } from "@/components/ui/EmptyState";

const COLOR_LABEL: Record<string, string> = {
  yellow: "Yellow",
  green: "Green",
  blue: "Blue",
  pink: "Pink",
};

interface HighlightsPanelProps {
  paperId: string;
}

function HighlightCard({
  h,
  pageNums,
  draft,
  onDraftChange,
  onNoteBlur,
  onDelete,
}: {
  h: Highlight;
  pageNums: number[];
  draft: string;
  onDraftChange: (v: string) => void;
  onNoteBlur: (note: string) => void;
  onDelete: () => void;
}) {
  const [showRaw, setShowRaw] = useState(false);
  const display = useMemo(
    () => formatHighlightDisplay(h.selected_text, pageNums),
    [h.selected_text, pageNums],
  );

  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-card/30 px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[var(--text-sm)] leading-relaxed text-foreground/90">
            {display.label}
          </p>
          {display.detail && (
            <p className="mt-1 text-[10px] text-muted-foreground/75">{display.detail}</p>
          )}
          {display.showRaw && (
            <button
              type="button"
              onClick={() => setShowRaw((v) => !v)}
              className="mt-1.5 text-[10px] font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {showRaw ? "Hide extracted text" : "Show extracted text"}
            </button>
          )}
          {showRaw && display.showRaw && (
            <p className="mt-1.5 rounded-md border border-border/40 bg-muted/[0.06] px-2 py-1.5 font-mono text-[10px] leading-relaxed text-muted-foreground/90 break-all">
              {display.raw}
            </p>
          )}
        </div>
        <span className="shrink-0 rounded-md border border-border/55 bg-muted/[0.08] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/85">
          {COLOR_LABEL[h.color] ?? h.color}
        </span>
      </div>
      <textarea
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        placeholder="Add a note…"
        rows={2}
        onBlur={(e) => onNoteBlur(e.target.value)}
        className="w-full resize-none rounded-md border border-border/50 bg-transparent px-2 py-1.5 text-[var(--text-sm)] text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      />
      <button
        type="button"
        onClick={onDelete}
        className="text-[var(--text-xs)] font-medium text-muted-foreground transition-colors motion-safe:duration-150 hover:text-destructive focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        Delete
      </button>
    </div>
  );
}

export function HighlightsPanel({ paperId }: HighlightsPanelProps) {
  const highlights = useStore((s) => s.highlightsByPaper[paperId] ?? EMPTY_HIGHLIGHTS_LIST);
  const regionHighlights = useStore(
    (s) => s.pdfRegionHighlightsByPaper[paperId] ?? EMPTY_PDF_REGIONS_LIST,
  );
  const visibleHighlights = highlights.filter(isPersistedHighlight);
  const removeHighlightForPaper = useStore((s) => s.removeHighlightForPaper);
  const addHighlightForPaper = useStore((s) => s.addHighlightForPaper);
  const bumpHighlightsFetchEpoch = useStore((s) => s.bumpHighlightsFetchEpoch);
  const updateHighlightForPaper = useStore((s) => s.updateHighlightForPaper);
  const [error, setError] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const pagesByHighlightId = useMemo(() => {
    const map = new Map<string, number[]>();
    for (const r of regionHighlights) {
      if (!r.highlightId) continue;
      const prev = map.get(r.highlightId) ?? [];
      if (!prev.includes(r.pageNum)) prev.push(r.pageNum);
      map.set(r.highlightId, prev);
    }
    return map;
  }, [regionHighlights]);

  const handleDelete = async (id: string) => {
    const snapshot = highlights.find((h) => h.id === id);
    bumpHighlightsFetchEpoch(paperId);
    removeHighlightForPaper(paperId, id);
    try {
      await api.deleteHighlight(paperId, id);
    } catch (e) {
      if (snapshot) addHighlightForPaper(paperId, snapshot);
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  };

  const handleNoteBlur = async (h: Highlight, note: string) => {
    const trimmed = note.trim();
    if (trimmed === (h.note ?? "")) return;
    updateHighlightForPaper(paperId, h.id, { note: trimmed });
    try {
      await api.updateHighlight(paperId, h.id, { note: trimmed });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    }
  };

  if (visibleHighlights.length === 0) {
    return (
      <EmptyState
        title="No highlights yet"
        body="Pick a passage in the PDF and choose a color from the toolbar."
      />
    );
  }

  return (
    <div className="space-y-3">
      {error && (
        <p role="alert" className="text-[var(--text-xs)] text-destructive">{error}</p>
      )}
      {visibleHighlights.map((h) => (
        <HighlightCard
          key={h.id}
          h={h}
          pageNums={pagesByHighlightId.get(h.id) ?? []}
          draft={drafts[h.id] ?? h.note ?? ""}
          onDraftChange={(v) => setDrafts((d) => ({ ...d, [h.id]: v }))}
          onNoteBlur={(note) => {
            void handleNoteBlur(h, note);
            setDrafts((d) => {
              const { [h.id]: _unused, ...rest } = d;
              void _unused;
              return rest;
            });
          }}
          onDelete={() => void handleDelete(h.id)}
        />
      ))}
    </div>
  );
}
