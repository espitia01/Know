import type { Highlight } from "@/lib/api";

/** Transient Q&A passage flashes — not user highlights. */
export function isPersistedHighlight(h: Highlight): boolean {
  return !h.id.startsWith("passage-flash-");
}

export function persistedHighlightCount(highlights: Highlight[] | undefined): number {
  return (highlights ?? []).filter(isPersistedHighlight).length;
}
