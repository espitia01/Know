"use client";

/**
 * Summary runs entirely on the Railway API (`/summary-generate`).
 * No Vercel AI SDK / streamObject — avoids Hobby 60s limits and OOM.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type PaperSummary } from "@/lib/api";
import {
  hasSummaryDeepBody,
  hasSummaryOverview,
  summaryIsComplete,
} from "@/lib/summaryState";
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

function describeError(error: unknown): string {
  if (!error) return "Summary generation failed. Try again.";
  const message = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(message) as {
      detail?: { code?: string; message?: string };
    };
    if (parsed.detail?.message) {
      const code = parsed.detail.code ? `[${parsed.detail.code}] ` : "";
      return `${code}${parsed.detail.message}`;
    }
  } catch {
    /* not JSON */
  }
  return message || "Summary generation failed. Try again.";
}

function dropNulls<T extends Record<string, unknown>>(value: Partial<T>): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === null) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

function mergeSummary(
  prev: PaperSummary | null,
  patch: Partial<PaperSummary>,
): PaperSummary {
  return dropNulls({ ...(prev ?? {}), ...patch }) as PaperSummary;
}

export function useSummaryStream(paperId: string) {
  const { analysisModel, fastModel } = useUserSettings();

  const setSummaryForPaper = useStore((s) => s.setSummaryForPaper);
  const setSummaryError = useStore((s) => s.setSummaryError);
  const setSummaryLoadingForPaper = useStore((s) => s.setSummaryLoadingForPaper);
  const updateCachedAnalysis = useStore((s) => s.updateCachedAnalysis);

  const abortRef = useRef<AbortController | null>(null);
  const autoRanRef = useRef(false);
  const [isLoading, setIsLoading] = useState(false);

  const mergeIntoPaperSlot = useCallback(
    (pid: string, patch: Partial<PaperSummary>) => {
      const prev = useStore.getState().summaryByPaper[pid] ?? null;
      const next = mergeSummary(prev, patch);
      const prevJson = prev ? JSON.stringify(prev) : "";
      const nextJson = JSON.stringify(next);
      if (prevJson === nextJson) return;
      setSummaryForPaper(pid, next as PaperSummary);
    },
    [setSummaryForPaper],
  );

  const runGenerate = useCallback(
    async (pid: string, phase: "full" | "deep") => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setIsLoading(true);
      setSummaryLoadingForPaper(pid, true);
      setSummaryError(pid, null);
      markRequestStart(pid, "summary");
      activeSummaryStreamStoppers.set(pid, () => controller.abort());

      try {
        const merged = await api.generateSummary(pid, {
          signal: controller.signal,
          phase,
          fastModel,
          analysisModel,
        });
        if (controller.signal.aborted) return;

        if (phase === "full" && !hasSummaryOverview(merged)) {
          throw new Error("Summary preview returned empty. Try again.");
        }
        if (!hasSummaryDeepBody(merged)) {
          throw new Error("Summary deep section returned empty. Try again.");
        }

        mergeIntoPaperSlot(pid, {
          ...(dropNulls(merged as Record<string, unknown>) as Partial<PaperSummary>),
          model: merged.model ?? analysisModel,
          created_at: Date.now(),
        });
        updateCachedAnalysis(pid, {
          summary: useStore.getState().summaryByPaper[pid] ?? merged,
          summary_lite: phase === "full" ? merged : undefined,
          summary_deep: merged,
        });
        setSummaryError(pid, null);
        autoAnalyzedPapers.add(`${pid}:summary`);
      } catch (e) {
        if (controller.signal.aborted) return;
        const existing = useStore.getState().summaryByPaper[pid];
        const msg = describeError(e);
        if (hasSummaryOverview(existing) && !hasSummaryDeepBody(existing)) {
          setSummaryError(pid, `Overview loaded, but the deep dive failed: ${msg}`);
        } else {
          setSummaryError(pid, msg);
        }
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
        setIsLoading(false);
        setSummaryLoadingForPaper(pid, false);
        markRequestEnd(pid, "summary");
        clearProgressStart(pid, "summary");
        activeSummaryStreamStoppers.delete(pid);
      }
    },
    [
      analysisModel,
      fastModel,
      mergeIntoPaperSlot,
      setSummaryError,
      setSummaryLoadingForPaper,
      updateCachedAnalysis,
    ],
  );

  const start = useCallback(() => {
    if (isLoading) return;
    const pid = paperId;
    const existing = useStore.getState().summaryByPaper[pid] ?? null;

    if (summaryIsComplete(existing)) {
      return;
    }

    const phase = hasSummaryOverview(existing) ? "deep" : "full";
    clearProgressStart(pid, "summary");
    void runGenerate(pid, phase);
  }, [paperId, isLoading, runGenerate]);

  // Auto-run deep when cache hydrated with lite only (fixes manual "Retry" button).
  useEffect(() => {
    if (autoRanRef.current || isLoading) return;
    const existing = useStore.getState().summaryByPaper[paperId] ?? null;
    if (hasSummaryOverview(existing) && !hasSummaryDeepBody(existing)) {
      autoRanRef.current = true;
      void runGenerate(paperId, "deep");
    }
  }, [paperId, isLoading, runGenerate]);

  useEffect(() => {
    summaryStreamStarters.set(paperId, start);
    return () => {
      summaryStreamStarters.delete(paperId);
    };
  }, [paperId, start]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setIsLoading(false);
    setSummaryLoadingForPaper(paperId, false);
    markRequestEnd(paperId, "summary");
    clearProgressStart(paperId, "summary");
    activeSummaryStreamStoppers.delete(paperId);
  }, [paperId, setSummaryLoadingForPaper]);

  return { start, stop, isLoading, error: undefined };
}

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
