"use client";

import { useEffect, useState } from "react";
import { api, type Highlight } from "@/lib/api";
import { useStore, EMPTY_HIGHLIGHTS_LIST } from "@/lib/store";
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
  const setHighlightsForPaper = useStore((s) => s.setHighlightsForPaper);
  const removeHighlightForPaper = useStore((s) => s.removeHighlightForPaper);
  const updateHighlightForPaper = useStore((s) => s.updateHighlightForPaper);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void api.listHighlights(paperId).then((res) => {
      if (cancelled) return;
      setHighlightsForPaper(paperId, res.items ?? []);
      setLoading(false);
    }).catch((e) => {
      if (cancelled) return;
      setError(e instanceof Error ? e.message : "Failed to load highlights");
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [paperId, setHighlightsForPaper]);

  const handleDelete = async (id: string) => {
    removeHighlightForPaper(paperId, id);
    try {
      await api.deleteHighlight(paperId, id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  };

  const handleNoteBlur = async (h: Highlight, note: string) => {
    updateHighlightForPaper(paperId, h.id, { note });
    try {
      await api.updateHighlight(paperId, h.id, { note });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    }
  };

  if (loading && highlights.length === 0) {
    return <p className="py-4 text-center text-[var(--text-sm)] text-muted-foreground">Loading highlights…</p>;
  }

  if (!loading && highlights.length === 0) {
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
      {highlights.map((h) => (
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
            defaultValue={h.note ?? ""}
            placeholder="Add a note…"
            rows={2}
            onBlur={(e) => void handleNoteBlur(h, e.target.value.trim())}
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
