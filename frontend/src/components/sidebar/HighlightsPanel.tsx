"use client";

import { useState } from "react";
import { api, type Highlight } from "@/lib/api";
import { useStore, EMPTY_HIGHLIGHTS_LIST } from "@/lib/store";
import { isPersistedHighlight } from "@/lib/highlightUtils";
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

export function HighlightsPanel({ paperId }: HighlightsPanelProps) {
  const highlights = useStore((s) => s.highlightsByPaper[paperId] ?? EMPTY_HIGHLIGHTS_LIST);
  const visibleHighlights = highlights.filter(isPersistedHighlight);
  const removeHighlightForPaper = useStore((s) => s.removeHighlightForPaper);
  const addHighlightForPaper = useStore((s) => s.addHighlightForPaper);
  const bumpHighlightsFetchEpoch = useStore((s) => s.bumpHighlightsFetchEpoch);
  const updateHighlightForPaper = useStore((s) => s.updateHighlightForPaper);
  const [error, setError] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});

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
        <div
          key={h.id}
          className="space-y-2 rounded-lg border border-border/60 bg-card/30 px-4 py-3"
        >
          <div className="flex items-start justify-between gap-2">
            <p className="text-[var(--text-sm)] leading-relaxed text-foreground/90 line-clamp-4">
              {h.selected_text}
            </p>
            <span className="shrink-0 rounded-md border border-border/55 bg-muted/[0.08] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/85">
              {COLOR_LABEL[h.color] ?? h.color}
            </span>
          </div>
          <textarea
            value={drafts[h.id] ?? h.note ?? ""}
            onChange={(e) => setDrafts((d) => ({ ...d, [h.id]: e.target.value }))}
            placeholder="Add a note…"
            rows={2}
            onBlur={(e) => {
              void handleNoteBlur(h, e.target.value);
              setDrafts((d) => {
                const { [h.id]: _unused, ...rest } = d;
                void _unused;
                return rest;
              });
            }}
            className="w-full resize-none rounded-md border border-border/50 bg-transparent px-2 py-1.5 text-[var(--text-sm)] text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
          <button
            type="button"
            onClick={() => void handleDelete(h.id)}
            className="text-[var(--text-xs)] font-medium text-muted-foreground transition-colors motion-safe:duration-150 hover:text-destructive focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Delete
          </button>
        </div>
      ))}
    </div>
  );
}
