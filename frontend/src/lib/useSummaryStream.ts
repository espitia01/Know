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
import {
  activeSummaryStreamStoppers,
  autoAnalyzedPapers,
  summaryStreamStarters,
  markRequestEnd,
  markRequestStart,
  clearProgressStart,
} from "@/lib/analysisState";

/** If the Vercel stream dies (~60s) with no partials, fall back to Python batch. */
const STREAM_FALLBACK_MS = 70_000;

export function useSummaryStream(paperId: string) {
  const setSummary = useStore((s) => s.setSummary);
  const setSummaryLoading = useStore((s) => s.setSummaryLoading);
  const updateCachedAnalysis = useStore((s) => s.updateCachedAnalysis);
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fallbackStartedRef = useRef(false);
  const startedForPaperRef = useRef<string | null>(null);

  const clearFallbackTimer = useCallback(() => {
    if (fallbackTimerRef.current != null) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
  }, []);

  const finishSummary = useCallback(
    (pid: string, summary: PaperSummary) => {
      if (useStore.getState().paper?.id !== pid) return;
      setSummary(summary);
      updateCachedAnalysis(pid, { summary });
    },
    [setSummary, updateCachedAnalysis],
  );

  const runBatchFallback = useCallback(
    async (pid: string) => {
      if (fallbackStartedRef.current) return;
      fallbackStartedRef.current = true;
      clearFallbackTimer();
      try {
        const summary = await api.getSummary(pid);
        if (summary?.overview) {
          finishSummary(pid, summary as PaperSummary);
          autoAnalyzedPapers.add(`${pid}:summary`);
        }
      } catch {
        /* batch fallback failed — panel shows retry */
      } finally {
        markRequestEnd(pid, "summary");
        clearProgressStart(pid, "summary");
        if (useStore.getState().paper?.id === pid) {
          setSummaryLoading(false);
        }
        activeSummaryStreamStoppers.delete(pid);
      }
    },
    [clearFallbackTimer, finishSummary, setSummaryLoading],
  );

  const obj = useObject({
    id: paperId,
    api: `/api/papers/${paperId}/summary-stream`,
    schema: PaperSummarySchema,
    onError: (error) => {
      clearFallbackTimer();
      const pid = startedForPaperRef.current;
      if (!pid) return;
      void runBatchFallback(pid);
    },
    onFinish: ({ object, error }) => {
      clearFallbackTimer();
      const pid = startedForPaperRef.current;
      if (!pid) return;
      startedForPaperRef.current = null;
      activeSummaryStreamStoppers.delete(pid);
      markRequestEnd(pid, "summary");
      clearProgressStart(pid, "summary");
      if (useStore.getState().paper?.id === pid) {
        setSummaryLoading(false);
      }
      if (object?.overview) {
        finishSummary(pid, object as PaperSummary);
        autoAnalyzedPapers.add(`${pid}:summary`);
        return;
      }
      if (error) {
        void runBatchFallback(pid);
      }
    },
  });

  // Mirror partial object into zustand so SummaryPanel can render while streaming.
  useEffect(() => {
    if (useStore.getState().paper?.id !== paperId) return;
    if (obj.object && Object.keys(obj.object).length > 0) {
      useStore.getState().setSummaryStreamingPartial(
        paperId,
        obj.object as Partial<PaperSummary>,
      );
    }
    if (!obj.isLoading) {
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
    setSummaryLoading(true);
    clearProgressStart(paperId, "summary");
    useStore.getState().setSummaryStreamingPartial(paperId, null);
    clearFallbackTimer();
    fallbackTimerRef.current = setTimeout(() => {
      if (!obj.isLoading) return;
      const partial = useStore.getState().summaryStreamingByPaper[paperId];
      const hasContent =
        partial &&
        typeof partial === "object" &&
        Object.keys(partial).some((k) => {
          const v = partial[k as keyof typeof partial];
          return typeof v === "string" ? v.trim().length > 0 : Array.isArray(v) && v.length > 0;
        });
      if (hasContent) return;
      obj.stop();
      void runBatchFallback(paperId);
    }, STREAM_FALLBACK_MS);
    obj.submit({});
  }, [
    paperId,
    obj,
    setSummaryLoading,
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
      useStore.getState().clearSummaryStreamingPartial(paperId);
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
