"use client";

/**
 * Two-phase Summary orchestrator (PROMPT_7 Track D).
 *
 * Phase 1 — **lite**: `useObject` against `/api/papers/[id]/summary-lite-stream`.
 * Returns overview + tl_dr + key contributions + a few equations in ~10 s on
 * Haiku. Persists to `cached_analysis.summary_lite` server-side.
 *
 * Phase 2 — **deep**: `useObject` against `/api/papers/[id]/summary-stream`.
 * Returns methodology / results / discussion / limitations / future work /
 * figures in 60–90 s on Sonnet. Persists to `cached_analysis.summary_deep`.
 *
 * Both phases write into `summaryByPaper[paperId]` as a shallow merge so the
 * panel renders a single coalesced `PaperSummary`. The deep phase auto-kicks
 * once the lite phase has an overview AND the user is on the same paper.
 *
 * Per-paper writes mean a stale stream from paper A cannot splatter into
 * paper B's panel after the user switches tabs — late writes simply update
 * A's slot which B's panel doesn't read.
 */

import { useCallback, useEffect, useRef } from "react";
import { experimental_useObject as useObject } from "@ai-sdk/react";
import { api } from "@/lib/api";
import {
  PaperSummaryDeepSchema,
  PaperSummaryLiteSchema,
  type PaperSummary,
  type PaperSummaryDeep,
  type PaperSummaryLite,
} from "@/lib/server/schemas";
import { useStore } from "@/lib/store";
import { useUserSettings } from "@/lib/UserSettingsContext";
import {
  activeSummaryStreamStoppers,
  autoAnalyzedPapers,
  summaryStreamStarters,
  markRequestEnd,
  markRequestStart,
  clearProgressStart,
} from "@/lib/analysisState";

/** Stream stall before Python batch fallback (Vercel often cuts ~60s). */
const LITE_FALLBACK_MS = 30_000;
const DEEP_FALLBACK_MS = 90_000;

function describeError(error: unknown): string {
  if (!error) return "Summary generation failed. Try again.";
  const message = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(message) as { detail?: { code?: string; message?: string } };
    if (parsed.detail?.message) return parsed.detail.message;
  } catch {
    /* not JSON */
  }
  return message || "Summary generation failed. Try again.";
}

function hasOverview(value: Partial<PaperSummary> | null | undefined): boolean {
  return typeof value?.overview === "string" && value.overview.trim().length > 0;
}

function hasDeepBody(value: Partial<PaperSummary> | null | undefined): boolean {
  return (
    typeof value?.methodology === "string" && value.methodology.trim().length > 0
  );
}

function mergeSummary(
  prev: PaperSummary | null,
  patch: Partial<PaperSummary>,
): PaperSummary {
  return { ...(prev ?? {}), ...patch } as PaperSummary;
}

export function useSummaryStream(paperId: string) {
  const { analysisModel, fastModel } = useUserSettings();

  // Per-paper writers (Track A): writes target `paperId`'s slot, not
  // whichever paper is currently active. A slow deep stream finishing
  // after the user switched away still lands in the right paper.
  const setSummaryForPaper = useStore((s) => s.setSummaryForPaper);
  const setSummaryError = useStore((s) => s.setSummaryError);
  const setSummaryLoadingForPaper = useStore((s) => s.setSummaryLoadingForPaper);
  const updateCachedAnalysis = useStore((s) => s.updateCachedAnalysis);

  const liteFallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deepFallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liteFallbackStarted = useRef(false);
  const deepFallbackStarted = useRef(false);
  const liteStartedFor = useRef<string | null>(null);
  const deepStartedFor = useRef<string | null>(null);
  const litePartialRef = useRef<Partial<PaperSummaryLite> | undefined>(undefined);
  const deepPartialRef = useRef<Partial<PaperSummaryDeep> | undefined>(undefined);
  const liteModelRef = useRef<string | undefined>(undefined);
  const deepModelRef = useRef<string | undefined>(undefined);

  const clearLiteTimer = useCallback(() => {
    if (liteFallbackTimer.current != null) {
      clearTimeout(liteFallbackTimer.current);
      liteFallbackTimer.current = null;
    }
  }, []);
  const clearDeepTimer = useCallback(() => {
    if (deepFallbackTimer.current != null) {
      clearTimeout(deepFallbackTimer.current);
      deepFallbackTimer.current = null;
    }
  }, []);

  const finishLoadingFlag = useCallback(
    (pid: string) => {
      // Loading flips off when *either* phase is fully done. We keep
      // it on while the deep is still streaming so the panel can show
      // the "Loading the deep dive…" inline pulse.
      const stillLite = liteStartedFor.current === pid;
      const stillDeep = deepStartedFor.current === pid;
      if (!stillLite && !stillDeep) {
        setSummaryLoadingForPaper(pid, false);
      }
    },
    [setSummaryLoadingForPaper],
  );

  /** Merge a partial into the per-paper summary slot. Late writes from
   *  a stale stream are not gated by `paper?.id === pid` — they land in
   *  their own paper's slot, which is the right place. */
  const mergeIntoPaperSlot = useCallback(
    (pid: string, patch: Partial<PaperSummary>) => {
      const prev = useStore.getState().summaryByPaper[pid] ?? null;
      const next = mergeSummary(prev, patch);
      setSummaryForPaper(pid, next);
    },
    [setSummaryForPaper],
  );

  const finishLite = useCallback(
    (pid: string, summary: PaperSummaryLite) => {
      setSummaryError(pid, null);
      const withMeta: PaperSummary = {
        ...summary,
        model: summary.model ?? liteModelRef.current,
        created_at: summary.created_at ?? Date.now(),
      };
      mergeIntoPaperSlot(pid, withMeta);
      updateCachedAnalysis(pid, { summary_lite: withMeta });
    },
    [mergeIntoPaperSlot, setSummaryError, updateCachedAnalysis],
  );

  const finishDeep = useCallback(
    (pid: string, summary: PaperSummaryDeep) => {
      const withMeta: PaperSummary = {
        ...summary,
        model: summary.model ?? deepModelRef.current,
      };
      mergeIntoPaperSlot(pid, withMeta);
      const merged = useStore.getState().summaryByPaper[pid];
      // Persist the merged blob to `cached_analysis.summary` so old
      // readers (single-slot) still get a usable payload.
      updateCachedAnalysis(pid, {
        summary_deep: withMeta,
        summary: merged ?? withMeta,
      });
    },
    [mergeIntoPaperSlot, updateCachedAnalysis],
  );

  const runBatchFallback = useCallback(
    async (pid: string) => {
      if (deepFallbackStarted.current) return;
      deepFallbackStarted.current = true;
      clearDeepTimer();
      setSummaryLoadingForPaper(pid, true);
      try {
        const summary = await api.getSummary(pid);
        if (hasOverview(summary)) {
          mergeIntoPaperSlot(pid, summary as PaperSummary);
          updateCachedAnalysis(pid, { summary });
          setSummaryError(pid, null);
          autoAnalyzedPapers.add(`${pid}:summary`);
          return;
        }
        setSummaryError(pid, "Summary generation returned empty results. Try again.");
      } catch (e) {
        setSummaryError(pid, describeError(e));
      } finally {
        deepStartedFor.current = null;
        liteStartedFor.current = null;
        markRequestEnd(pid, "summary");
        clearProgressStart(pid, "summary");
        activeSummaryStreamStoppers.delete(pid);
        finishLoadingFlag(pid);
      }
    },
    [
      clearDeepTimer,
      finishLoadingFlag,
      mergeIntoPaperSlot,
      setSummaryError,
      setSummaryLoadingForPaper,
      updateCachedAnalysis,
    ],
  );

  // ---- Lite phase ---------------------------------------------------
  const liteObj = useObject({
    id: `${paperId}-lite`,
    api: `/api/papers/${paperId}/summary-lite-stream`,
    schema: PaperSummaryLiteSchema,
    credentials: "include",
    onError: (error) => {
      clearLiteTimer();
      const pid = liteStartedFor.current;
      liteStartedFor.current = null;
      if (!pid) return;
      setSummaryError(pid, describeError(error));
      // Lite died — go straight to the batch fallback (which produces
      // a full summary including the deep fields).
      void runBatchFallback(pid);
    },
    onFinish: ({ object, error }) => {
      clearLiteTimer();
      const pid = liteStartedFor.current;
      liteStartedFor.current = null;
      if (!pid) return;
      const candidate = (object ?? litePartialRef.current) as
        | Partial<PaperSummaryLite>
        | undefined;
      if (hasOverview(candidate)) {
        finishLite(pid, candidate as PaperSummaryLite);
        finishLoadingFlag(pid);
        // Auto-kick deep once lite lands.
        startDeep(pid);
        return;
      }
      if (error) setSummaryError(pid, describeError(error));
      void runBatchFallback(pid);
    },
  });

  litePartialRef.current = liteObj.object as Partial<PaperSummaryLite> | undefined;
  const lastLiteMergeKey = useRef("");

  useEffect(() => {
    const pid = liteStartedFor.current;
    if (!pid) return;
    const partial = liteObj.object as Partial<PaperSummaryLite> | undefined;
    if (!partial || !(partial.overview || partial.tl_dr || partial.key_contributions?.length)) {
      return;
    }
    const mergeKey = JSON.stringify(partial);
    if (mergeKey === lastLiteMergeKey.current) return;
    lastLiteMergeKey.current = mergeKey;
    mergeIntoPaperSlot(pid, {
      ...partial,
      model: liteModelRef.current,
    });
  }, [liteObj.object, mergeIntoPaperSlot]);

  // ---- Deep phase ---------------------------------------------------
  const deepObj = useObject({
    id: `${paperId}-deep`,
    api: `/api/papers/${paperId}/summary-stream`,
    schema: PaperSummaryDeepSchema,
    credentials: "include",
    onError: (error) => {
      clearDeepTimer();
      const pid = deepStartedFor.current;
      deepStartedFor.current = null;
      if (!pid) return;
      setSummaryError(pid, describeError(error));
      finishLoadingFlag(pid);
    },
    onFinish: ({ object, error }) => {
      clearDeepTimer();
      const pid = deepStartedFor.current;
      deepStartedFor.current = null;
      if (!pid) return;
      const candidate = (object ?? deepPartialRef.current) as
        | Partial<PaperSummaryDeep>
        | undefined;
      if (hasDeepBody(candidate)) {
        finishDeep(pid, candidate as PaperSummaryDeep);
        markRequestEnd(pid, "summary");
        clearProgressStart(pid, "summary");
        activeSummaryStreamStoppers.delete(pid);
        autoAnalyzedPapers.add(`${pid}:summary`);
        finishLoadingFlag(pid);
        return;
      }
      if (error) setSummaryError(pid, describeError(error));
      finishLoadingFlag(pid);
    },
  });

  deepPartialRef.current = deepObj.object as Partial<PaperSummaryDeep> | undefined;
  const lastDeepMergeKey = useRef("");

  useEffect(() => {
    const pid = deepStartedFor.current;
    if (!pid) return;
    const partial = deepObj.object as Partial<PaperSummaryDeep> | undefined;
    if (!partial || !(partial.methodology || partial.main_results || partial.discussion)) {
      return;
    }
    const mergeKey = JSON.stringify(partial);
    if (mergeKey === lastDeepMergeKey.current) return;
    lastDeepMergeKey.current = mergeKey;
    mergeIntoPaperSlot(pid, {
      ...partial,
      model: deepModelRef.current,
    });
  }, [deepObj.object, mergeIntoPaperSlot]);

  // ---- Public starters ---------------------------------------------
  const startDeep = useCallback(
    (pid: string) => {
      if (deepObj.isLoading) return;
      deepFallbackStarted.current = false;
      deepStartedFor.current = pid;
      deepModelRef.current = analysisModel;
      lastDeepMergeKey.current = "";
      setSummaryLoadingForPaper(pid, true);
      clearDeepTimer();
      deepFallbackTimer.current = setTimeout(() => {
        if (!deepObj.isLoading) return;
        if (hasDeepBody(deepPartialRef.current)) return;
        deepObj.stop();
        void runBatchFallback(pid);
      }, DEEP_FALLBACK_MS);
      deepObj.submit({});
    },
    [analysisModel, clearDeepTimer, deepObj, runBatchFallback, setSummaryLoadingForPaper],
  );

  const start = useCallback(() => {
    if (liteObj.isLoading || deepObj.isLoading) return;
    const pid = paperId;

    // If lite is already cached server-side it gets hydrated by the
    // page's `cachedAnalysis` path; the caller still routes through
    // start() to ensure the deep phase runs on demand. Skip the lite
    // stream when we already have an overview in the per-paper slot.
    const existing = useStore.getState().summaryByPaper[pid] ?? null;
    if (hasOverview(existing) && !hasDeepBody(existing)) {
      // Lite already done, deep missing — skip lite, jump to deep.
      markRequestStart(pid, "summary");
      activeSummaryStreamStoppers.set(pid, () => {
        clearDeepTimer();
        deepObj.stop();
      });
      setSummaryError(pid, null);
      clearProgressStart(pid, "summary");
      startDeep(pid);
      return;
    }
    if (hasOverview(existing) && hasDeepBody(existing)) {
      // Nothing to do — both phases already on disk and merged.
      return;
    }

    liteFallbackStarted.current = false;
    liteStartedFor.current = pid;
    liteModelRef.current = fastModel;
    lastLiteMergeKey.current = "";
    lastDeepMergeKey.current = "";
    markRequestStart(pid, "summary");
    activeSummaryStreamStoppers.set(pid, () => {
      clearLiteTimer();
      clearDeepTimer();
      liteObj.stop();
      deepObj.stop();
    });
    setSummaryError(pid, null);
    setSummaryLoadingForPaper(pid, true);
    clearProgressStart(pid, "summary");
    clearLiteTimer();
    liteFallbackTimer.current = setTimeout(() => {
      if (!liteObj.isLoading) return;
      if (hasOverview(litePartialRef.current as Partial<PaperSummary>)) return;
      liteObj.stop();
      void runBatchFallback(pid);
    }, LITE_FALLBACK_MS);
    liteObj.submit({});
  }, [
    paperId,
    fastModel,
    liteObj,
    deepObj,
    clearLiteTimer,
    clearDeepTimer,
    runBatchFallback,
    setSummaryError,
    setSummaryLoadingForPaper,
    startDeep,
  ]);

  useEffect(() => {
    summaryStreamStarters.set(paperId, start);
    return () => {
      summaryStreamStarters.delete(paperId);
    };
  }, [paperId, start]);

  const stop = useCallback(() => {
    clearLiteTimer();
    clearDeepTimer();
    liteObj.stop();
    deepObj.stop();
    const pid = liteStartedFor.current || deepStartedFor.current || paperId;
    liteStartedFor.current = null;
    deepStartedFor.current = null;
    markRequestEnd(pid, "summary");
    clearProgressStart(pid, "summary");
    activeSummaryStreamStoppers.delete(pid);
    finishLoadingFlag(pid);
  }, [paperId, liteObj, deepObj, clearLiteTimer, clearDeepTimer, finishLoadingFlag]);

  return {
    start,
    stop,
    isLoading: liteObj.isLoading || deepObj.isLoading,
    error: liteObj.error || deepObj.error,
  };
}

/** Retry until the page-level hook registers its start handler. */
export function kickoffSummaryStream(paperId: string, maxAttempts = 40): void {
  let attempts = 0;
  const tryStart = () => {
    const start = summaryStreamStarters.get(paperId);
    if (start) {
      start();
      return;
    }
    if (++attempts >= maxAttempts) return;
    requestAnimationFrame(tryStart);
  };
  tryStart();
}
