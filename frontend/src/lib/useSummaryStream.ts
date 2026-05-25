"use client";

/**
 * Two-phase summary — both phases on Railway (batch JSON).
 * Vercel Hobby's 60s cap prevented the deep stream from finishing.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type PaperSummary } from "@/lib/api";
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
      detail?: { code?: string; message?: string; model?: string };
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

function hasOverview(value: { overview?: string | null } | null | undefined): boolean {
  return typeof value?.overview === "string" && value.overview.trim().length > 0;
}

function hasDeepBody(value: { methodology?: string | null } | null | undefined): boolean {
  return (
    typeof value?.methodology === "string" && value.methodology.trim().length > 0
  );
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

  const runDeep = useCallback(
    async (pid: string, signal: AbortSignal) => {
      const deep = await api.getSummaryDeep(pid, {
        signal,
        model: analysisModel,
      });
      if (!hasDeepBody(deep)) {
        throw new Error("Summary deep section returned empty. Try again.");
      }
      const body = dropNulls(deep as Record<string, unknown>) as Partial<PaperSummary>;
      mergeIntoPaperSlot(pid, {
        ...body,
        model: deep.model ?? analysisModel,
      });
      const merged = useStore.getState().summaryByPaper[pid];
      updateCachedAnalysis(pid, {
        summary_deep: { ...body, model: deep.model ?? analysisModel },
        summary: merged ?? { ...body, model: deep.model ?? analysisModel },
      });
    },
    [analysisModel, mergeIntoPaperSlot, updateCachedAnalysis],
  );

  const runLite = useCallback(
    async (pid: string, signal: AbortSignal) => {
      const lite = await api.getSummaryLite(pid, {
        signal,
        model: fastModel,
      });
      if (!hasOverview(lite)) {
        throw new Error("Summary preview returned empty. Try again.");
      }
      mergeIntoPaperSlot(pid, {
        ...(dropNulls(lite as Record<string, unknown>) as Partial<PaperSummary>),
        model: lite.model ?? fastModel,
        created_at: Date.now(),
      });
      updateCachedAnalysis(pid, { summary_lite: lite });
    },
    [fastModel, mergeIntoPaperSlot, updateCachedAnalysis],
  );

  const runPipeline = useCallback(
    async (pid: string, liteOnly: boolean) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setIsLoading(true);
      setSummaryLoadingForPaper(pid, true);
      setSummaryError(pid, null);
      markRequestStart(pid, "summary");
      activeSummaryStreamStoppers.set(pid, () => controller.abort());

      try {
        if (!liteOnly) {
          await runLite(pid, controller.signal);
        }
        if (controller.signal.aborted) return;
        await runDeep(pid, controller.signal);
        if (controller.signal.aborted) return;
        setSummaryError(pid, null);
        autoAnalyzedPapers.add(`${pid}:summary`);
      } catch (e) {
        if (controller.signal.aborted) return;
        const existing = useStore.getState().summaryByPaper[pid];
        const msg = describeError(e);
        if (hasOverview(existing) && !hasDeepBody(existing)) {
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
      runDeep,
      runLite,
      setSummaryError,
      setSummaryLoadingForPaper,
    ],
  );

  const start = useCallback(() => {
    if (isLoading) return;
    const pid = paperId;
    const existing = useStore.getState().summaryByPaper[pid] ?? null;

    if (hasOverview(existing) && hasDeepBody(existing)) {
      return;
    }
    if (hasOverview(existing) && !hasDeepBody(existing)) {
      clearProgressStart(pid, "summary");
      void runPipeline(pid, true);
      return;
    }

    clearProgressStart(pid, "summary");
    void runPipeline(pid, false);
  }, [paperId, isLoading, runPipeline]);

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
