// Shared module-level state for background analysis tracking.
// Persists across component remounts (orientation change, paper switches) so in-flight
// requests are not re-triggered and progress bars keep running.

export type AnalysisKind = "preReading" | "assumptions" | "summary";

export const autoAnalyzedPapers = new Set<string>();
export const activeRequests = new Map<string, Set<AnalysisKind>>();
export const activeSummaryStreams = new Map<string, AbortController>();

function requestSet(paperId: string): Set<AnalysisKind> {
  let s = activeRequests.get(paperId);
  if (!s) {
    s = new Set();
    activeRequests.set(paperId, s);
  }
  return s;
}

export function markRequestStart(paperId: string, kind: AnalysisKind) {
  requestSet(paperId).add(kind);
}

export function markRequestEnd(paperId: string, kind: AnalysisKind) {
  activeRequests.get(paperId)?.delete(kind);
}

export function hasActiveRequest(paperId: string, kind: AnalysisKind): boolean {
  if (kind === "summary") return activeSummaryStreams.has(paperId);
  return activeRequests.get(paperId)?.has(kind) ?? false;
}

// Progress bar start times keyed by `${paperId}:${kind}`. Persist across remounts so
// switching papers / orientations while loading does not reset the visual progress.
const progressStartTimes = new Map<string, number>();

function progressKey(paperId: string, kind: AnalysisKind): string {
  return `${paperId}:${kind}`;
}

export function getProgressStart(paperId: string, kind: AnalysisKind): number {
  const key = progressKey(paperId, kind);
  let t = progressStartTimes.get(key);
  if (t == null) {
    t = Date.now();
    progressStartTimes.set(key, t);
  }
  return t;
}

export function clearProgressStart(paperId: string, kind: AnalysisKind) {
  progressStartTimes.delete(progressKey(paperId, kind));
}

// Drop every trace of tracking for a paper. Call this when the paper is
// removed from the session / workspace so the `autoAnalyzedPapers` guard
// doesn't swell unboundedly and so a paper that's re-added later triggers
// a fresh auto-analyze instead of silently skipping it.
export function forgetPaper(paperId: string) {
  autoAnalyzedPapers.delete(paperId);
  activeRequests.delete(paperId);
  const stream = activeSummaryStreams.get(paperId);
  if (stream) {
    try { stream.abort(); } catch { /* ignore */ }
    activeSummaryStreams.delete(paperId);
  }
  for (const key of Array.from(progressStartTimes.keys())) {
    if (key.startsWith(`${paperId}:`)) progressStartTimes.delete(key);
  }
}
