"use client";

/**
 * Page-level summary streaming via `experimental_useObject` against the
 * migrated Next.js `/api/papers/[id]/summary-stream` route. Syncs partial
 * objects into zustand for SummaryPanel and falls back to the Python batch
 * `/api/papers/[id]/summary` endpoint when the stream stalls or fails.
 */

import { useCallback, useEffect, useRef } from "react";
import { experimental_useObject as useObject } from "@ai-sdk/react";
import { api } from "@/lib/api";
import { PaperSummarySchema, type PaperSummary } from "@/lib/server/schemas";
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
const STREAM_FALLBACK_MS = 55_000;

function describeError(error: unknown): string {
  if (!error) return "Summary generation failed. Try again.";
  const message = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(message) as { detail?: { code?: string; message?: string } };
    if (parsed.detail?.message) {
      const code = parsed.detail.code;
      if (code === "tier_locked" || code === "paper_cap" || code === "daily_cap" || code === "model_cap") {
        return parsed.detail.message;
      }
      return parsed.detail.message;
    }
  } catch {
    /* not JSON */
  }
  return message || "Summary generation failed. Try again.";
}

function hasOverview(value: Partial<PaperSummary> | null | undefined): boolean {
  return typeof value?.overview === "string" && value.overview.trim().length > 0;
}

function hasMeaningfulPartial(value: Partial<PaperSummary> | null | undefined): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.keys(value).some((k) => {
    const v = value[k as keyof PaperSummary];
    if (typeof v === "string") return v.trim().length > 0;
    return Array.isArray(v) && v.length > 0;
  });
}

export function useSummaryStream(paperId: string) {
  const { analysisModel } = useUserSettings();
  const setSummary = useStore((s) => s.setSummary);
  const setSummaryLoading = useStore((s) => s.setSummaryLoading);
  const setSummaryError = useStore((s) => s.setSummaryError);
  const updateCachedAnalysis = useStore((s) => s.updateCachedAnalysis);
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fallbackStartedRef = useRef(false);
  const startedForPaperRef = useRef<string | null>(null);
  const latestObjectRef = useRef<Partial<PaperSummary> | undefined>(undefined);
  const streamModelRef = useRef<string | undefined>(undefined);

  const clearFallbackTimer = useCallback(() => {
    if (fallbackTimerRef.current != null) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
  }, []);

  const finishSummary = useCallback(
    (pid: string, summary: PaperSummary) => {
      if (useStore.getState().paper?.id !== pid) return;
      setSummaryError(pid, null);
      const withMeta: PaperSummary = {
        ...summary,
        model: summary.model ?? streamModelRef.current,
        created_at: summary.created_at ?? Date.now(),
      };
      setSummary(withMeta);
      updateCachedAnalysis(pid, { summary: withMeta });
      useStore.getState().clearSummaryStreamingPartial(pid);
    },
    [setSummary, setSummaryError, updateCachedAnalysis],
  );

  const runBatchFallback = useCallback(
    async (pid: string) => {
      if (fallbackStartedRef.current) return;
      fallbackStartedRef.current = true;
      clearFallbackTimer();
      if (useStore.getState().paper?.id === pid) {
        setSummaryLoading(true);
      }
      try {
        const summary = await api.getSummary(pid);
        if (hasOverview(summary)) {
          finishSummary(pid, summary as PaperSummary);
          autoAnalyzedPapers.add(`${pid}:summary`);
          return;
        }
        if (useStore.getState().paper?.id === pid) {
          setSummaryError(pid, "Summary generation returned empty results. Try again.");
        }
      } catch (e) {
        if (useStore.getState().paper?.id === pid) {
          setSummaryError(pid, describeError(e));
        }
      } finally {
        markRequestEnd(pid, "summary");
        clearProgressStart(pid, "summary");
        activeSummaryStreamStoppers.delete(pid);
        if (useStore.getState().paper?.id === pid) {
          setSummaryLoading(false);
        }
      }
    },
    [clearFallbackTimer, finishSummary, setSummaryLoading, setSummaryError],
  );

  const obj = useObject({
    id: paperId,
    api: `/api/papers/${paperId}/summary-stream`,
    schema: PaperSummarySchema,
    credentials: "include",
    onError: (error) => {
      clearFallbackTimer();
      const pid = startedForPaperRef.current;
      if (!pid) return;
      useStore.getState().clearSummaryStreamingPartial(pid);
      if (useStore.getState().paper?.id === pid) {
        setSummaryError(pid, describeError(error));
      }
      void runBatchFallback(pid);
    },
    onFinish: ({ object, error }) => {
      clearFallbackTimer();
      const pid = startedForPaperRef.current;
      if (!pid) return;
      startedForPaperRef.current = null;
      activeSummaryStreamStoppers.delete(pid);
      useStore.getState().clearSummaryStreamingPartial(pid);

      const candidate = (object ?? latestObjectRef.current) as Partial<PaperSummary> | undefined;
      if (hasOverview(candidate)) {
        markRequestEnd(pid, "summary");
        clearProgressStart(pid, "summary");
        if (useStore.getState().paper?.id === pid) {
          setSummaryLoading(false);
        }
        finishSummary(pid, candidate as PaperSummary);
        autoAnalyzedPapers.add(`${pid}:summary`);
        return;
      }

      if (error && useStore.getState().paper?.id === pid) {
        setSummaryError(pid, describeError(error));
      }

      void runBatchFallback(pid);
    },
  });

  latestObjectRef.current = obj.object as Partial<PaperSummary> | undefined;

  useEffect(() => {
    if (useStore.getState().paper?.id !== paperId) return;
    if (obj.object && hasMeaningfulPartial(obj.object as Partial<PaperSummary>)) {
      useStore.getState().setSummaryStreamingPartial(paperId, {
        ...(obj.object as Partial<PaperSummary>),
        model: streamModelRef.current,
      });
    }
    if (!obj.isLoading && hasOverview(useStore.getState().summary)) {
      useStore.getState().clearSummaryStreamingPartial(paperId);
    }
  }, [paperId, obj.object, obj.isLoading]);

  const start = useCallback(() => {
    if (obj.isLoading) return;
    fallbackStartedRef.current = false;
    startedForPaperRef.current = paperId;
    markRequestStart(paperId, "summary");
    activeSummaryStreamStoppers.set(paperId, () => {
      clearFallbackTimer();
      obj.stop();
    });
    setSummaryError(paperId, null);
    setSummaryLoading(true);
    clearProgressStart(paperId, "summary");
    useStore.getState().setSummaryStreamingPartial(paperId, null);
    clearFallbackTimer();
    fallbackTimerRef.current = setTimeout(() => {
      if (!obj.isLoading) return;
      if (hasOverview(latestObjectRef.current)) return;
      if (hasMeaningfulPartial(latestObjectRef.current)) return;
      obj.stop();
      void runBatchFallback(paperId);
    }, STREAM_FALLBACK_MS);
    streamModelRef.current = analysisModel;
    useStore.getState().setSummaryStreamingPartial(paperId, { model: analysisModel });
    obj.submit({});
  }, [
    paperId,
    analysisModel,
    obj,
    setSummaryLoading,
    setSummaryError,
    clearFallbackTimer,
    runBatchFallback,
  ]);

  useEffect(() => {
    summaryStreamStarters.set(paperId, start);
    return () => {
      summaryStreamStarters.delete(paperId);
    };
  }, [paperId, start]);

  const stop = useCallback(() => {
    clearFallbackTimer();
    obj.stop();
    startedForPaperRef.current = null;
    markRequestEnd(paperId, "summary");
    clearProgressStart(paperId, "summary");
    activeSummaryStreamStoppers.delete(paperId);
    if (useStore.getState().paper?.id === paperId) {
      setSummaryLoading(false);
    }
  }, [paperId, obj, clearFallbackTimer, setSummaryLoading]);

  return {
    start,
    stop,
    isLoading: obj.isLoading,
    error: obj.error,
    object: obj.object,
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
