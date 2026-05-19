/**
 * In-memory paper freshness gate (PROMPT_7 Track B1).
 *
 * Marks the last time `api.getPaper(id)` returned for each paper. The
 * reader page's data-fetch effect skips the network round-trip when a
 * cached copy is "fresh enough" — `papersById[id]` provides instant
 * rendering and the LRU cache is always seeded by the upload flow or a
 * prior open. Background mutators (folder/title/figure re-extract /
 * cached_analysis updates of *other* papers) invalidate the entry so
 * the next switch refetches.
 */

const FRESH_FOR_MS = 5 * 60_000;

const lastFetchedAt = new Map<string, number>();

export function markPaperFetched(id: string): void {
  if (!id) return;
  lastFetchedAt.set(id, Date.now());
}

export function isPaperFresh(id: string): boolean {
  if (!id) return false;
  const t = lastFetchedAt.get(id);
  return t != null && Date.now() - t < FRESH_FOR_MS;
}

export function invalidatePaper(id: string): void {
  if (!id) return;
  lastFetchedAt.delete(id);
}

export function clearAllPaperFreshness(): void {
  lastFetchedAt.clear();
}
