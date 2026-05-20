// Shared module-level state for background analysis tracking.
// Persists across component remounts (orientation change, paper switches) so in-flight
// requests are not re-triggered and progress bars keep running.

import type { Assumption, ParsedPaper } from "@/lib/api";
import { isPreReadingPopulated } from "@/lib/preReading";

type CacheSlice = NonNullable<ParsedPaper["cached_analysis"]>;

export type AnalysisKind = "preReading" | "assumptions" | "summary";

export const autoAnalyzedPapers = new Set<string>();
/** Last auto-Prepare failure per paper — suppress retry storms for 30s. */
export const preReadingAutoRetryCooldownUntil = new Map<string, number>();
export const activeRequests = new Map<string, Set<AnalysisKind>>();
/** In-flight summary stream stop handlers (from `useSummaryStream`). */
export const activeSummaryStreamStoppers = new Map<string, () => void>();
/** Registered `start()` from the page-level `useSummaryStream` hook. */
export const summaryStreamStarters = new Map<string, () => void>();

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
  for (const key of Array.from(autoAnalyzedPapers)) {
    if (key === paperId || key.startsWith(`${paperId}:`)) {
      autoAnalyzedPapers.delete(key);
    }
  }
  preReadingAutoRetryCooldownUntil.delete(paperId);
  activeRequests.delete(paperId);
  activeSummaryStreamStoppers.get(paperId)?.();
  activeSummaryStreamStoppers.delete(paperId);
  for (const key of Array.from(progressStartTimes.keys())) {
    if (key.startsWith(`${paperId}:`)) progressStartTimes.delete(key);
  }
}

/** Non-empty assumptions list from a cached_analysis blob, if any. */
export function getCachedAssumptionItems(
  cache: CacheSlice | undefined,
): Assumption[] | null {
  const items = cache?.assumptions?.assumptions;
  return Array.isArray(items) && items.length > 0 ? items : null;
}

/** Matches backend `assumptions_cooldown_until` TTL on empty extraction. */
export const ASSUMPTIONS_COOLDOWN_SEC = 1800;

/** True when a recent empty extraction should suppress auto-retry. */
export function assumptionsCooldownActive(
  cache: CacheSlice | undefined,
  sessionCache?: CacheSlice,
): boolean {
  const until = Math.max(
    Number(cache?.assumptions_cooldown_until || 0),
    Number(sessionCache?.assumptions_cooldown_until || 0),
  );
  return until > Date.now() / 1000;
}

/** Persist a local cooldown + guard so auto-analyze does not hammer 502s. */
export function markAssumptionsAttemptFailed(
  paperId: string,
  updateCachedAnalysis: (paperId: string, partial: Record<string, unknown>) => void,
): void {
  autoAnalyzedPapers.add(`${paperId}:assumptions`);
  updateCachedAnalysis(paperId, {
    assumptions_cooldown_until:
      Math.floor(Date.now() / 1000) + ASSUMPTIONS_COOLDOWN_SEC,
  });
}

/**
 * Align session auto-analyze guards with what is already on disk / in
 * `papersById`. Clears a guard only when that artifact is truly missing
 * (so dashboard → reopen can retry a failed first pass) and *sets* the
 * guard when cache already has data (so we do not re-extract assumptions).
 */
export function syncAutoAnalyzeGuardsFromCache(
  paperId: string,
  cache: CacheSlice = {},
  sessionCache: CacheSlice = {},
) {
  const hasPre =
    isPreReadingPopulated(cache.pre_reading) ||
    isPreReadingPopulated(sessionCache.pre_reading);
  if (hasPre) {
    autoAnalyzedPapers.add(`${paperId}:preReading`);
  } else {
    autoAnalyzedPapers.delete(`${paperId}:preReading`);
  }

  const cachedAssume =
    getCachedAssumptionItems(cache) ?? getCachedAssumptionItems(sessionCache);
  const assumeItems = cache.assumptions?.assumptions;
  const sessionAssumeItems = sessionCache.assumptions?.assumptions;
  const hasEmptyAssumeKey =
    (Array.isArray(assumeItems) && assumeItems.length === 0) ||
    (Array.isArray(sessionAssumeItems) && sessionAssumeItems.length === 0);
  const coolingDown = assumptionsCooldownActive(cache, sessionCache);
  if (cachedAssume) {
    autoAnalyzedPapers.add(`${paperId}:assumptions`);
  } else if (hasEmptyAssumeKey || coolingDown) {
    autoAnalyzedPapers.add(`${paperId}:assumptions`);
  } else {
    autoAnalyzedPapers.delete(`${paperId}:assumptions`);
  }

  const hasSummary = !!(cache.summary || sessionCache.summary);
  if (hasSummary) {
    autoAnalyzedPapers.add(`${paperId}:summary`);
  } else {
    autoAnalyzedPapers.delete(`${paperId}:summary`);
  }
}

/** @deprecated Use `syncAutoAnalyzeGuardsFromCache` — blind clear retriggers cached work. */
export function allowAutoAnalyzeRetry(paperId: string) {
  autoAnalyzedPapers.delete(`${paperId}:preReading`);
  autoAnalyzedPapers.delete(`${paperId}:assumptions`);
  autoAnalyzedPapers.delete(`${paperId}:summary`);
}

/** Abort an in-flight summary stream for a paper (e.g. when switching away). */
export function abortActiveSummaryStream(paperId: string) {
  activeSummaryStreamStoppers.get(paperId)?.();
  activeSummaryStreamStoppers.delete(paperId);
  markRequestEnd(paperId, "summary");
}
