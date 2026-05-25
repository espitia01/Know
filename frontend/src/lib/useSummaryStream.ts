"use client";

/**
 * Two-phase summary: lite preview on Railway (no Vercel 60s cap),
 * deep body streamed on Vercel `/summary-stream`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { experimental_useObject as useObject } from "@ai-sdk/react";
import { api, type PaperSummary } from "@/lib/api";
import {
  PaperSummaryDeepBodySchema,
  type PaperSummaryDeepBody,
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

function describeError(error: unknown): string {
  if (!error) return "Summary generation failed. Try again.";
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("<!DOCTYPE html") ||
    message.includes("Internal Server Error") ||
    message.includes("SIGABRT") ||
    message.includes("heap out of memory") ||
    message.includes("504")
  ) {
    return "Summary timed out or crashed on the server. Retry in a moment; use Haiku/Mistral Small if it persists.";
  }
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
  if (message.includes("paper_text_unavailable")) {
    return "Paper text is not ready yet. Wait for parsing to finish, then try again.";
  }
  if (message.includes("usage_unavailable") || message.includes("usage tracking")) {
    return "Usage tracking is temporarily unavailable. If this persists, confirm migration 023 is applied on Supabase.";
  }
  if (message.includes("provider_error") || message.includes("Provider error")) {
    return "The analysis model could not run. Check provider keys / AI Gateway, or pick another model in Settings.";
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
  const merged = { ...(prev ?? {}), ...patch };
  return dropNulls(merged) as PaperSummary;
}

export function useSummaryStream(paperId: string) {
  const { analysisModel, fastModel } = useUserSettings();

  const setSummaryForPaper = useStore((s) => s.setSummaryForPaper);
  const setSummaryError = useStore((s) => s.setSummaryError);
  const setSummaryLoadingForPaper = useStore((s) => s.setSummaryLoadingForPaper);
  const updateCachedAnalysis = useStore((s) => s.updateCachedAnalysis);

  const liteAbortRef = useRef<AbortController | null>(null);
  const liteStartedFor = useRef<string | null>(null);
  const deepStartedFor = useRef<string | null>(null);
  const deepModelRef = useRef<string | undefined>(undefined);
  const [liteLoading, setLiteLoading] = useState(false);

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

  const finishLoadingFlag = useCallback(
    (pid: string) => {
      const stillLite = liteStartedFor.current === pid;
      const stillDeep = deepStartedFor.current === pid;
      if (!stillLite && !stillDeep) {
        setSummaryLoadingForPaper(pid, false);
      }
    },
    [setSummaryLoadingForPaper],
  );

  const deepObj = useObject({
    id: `${paperId}-deep`,
    api: `/api/papers/${paperId}/summary-stream`,
    schema: PaperSummaryDeepBodySchema,
    credentials: "include",
    onError: (error) => {
      const pid = deepStartedFor.current;
      deepStartedFor.current = null;
      if (!pid) return;
      const existing = useStore.getState().summaryByPaper[pid];
      if (!hasOverview(existing)) {
        setSummaryError(pid, describeError(error));
      } else {
        setSummaryError(
          pid,
          `Overview loaded, but the deep dive failed: ${describeError(error)}`,
        );
      }
      markRequestEnd(pid, "summary");
      clearProgressStart(pid, "summary");
      activeSummaryStreamStoppers.delete(pid);
      finishLoadingFlag(pid);
    },
    onFinish: ({ object, error }) => {
      const pid = deepStartedFor.current;
      deepStartedFor.current = null;
      if (!pid) return;
      const candidate = object as Partial<PaperSummaryDeepBody> | undefined;
      if (hasDeepBody(candidate)) {
        const body = dropNulls(candidate ?? {}) as Partial<PaperSummary>;
        mergeIntoPaperSlot(pid, {
          ...body,
          model: deepModelRef.current,
        });
        const merged = useStore.getState().summaryByPaper[pid];
        updateCachedAnalysis(pid, {
          summary_deep: { ...body, model: deepModelRef.current },
          summary: merged ?? { ...body, model: deepModelRef.current },
        });
        setSummaryError(pid, null);
        autoAnalyzedPapers.add(`${pid}:summary`);
        markRequestEnd(pid, "summary");
        clearProgressStart(pid, "summary");
        activeSummaryStreamStoppers.delete(pid);
        finishLoadingFlag(pid);
        return;
      }
      const existing = useStore.getState().summaryByPaper[pid];
      setSummaryError(
        pid,
        hasOverview(existing)
          ? error
            ? `Overview loaded, but the deep dive failed: ${describeError(error)}`
            : "Overview loaded, but methodology did not stream. Try again."
          : error
            ? describeError(error)
            : "Summary deep section returned empty. Try again.",
      );
      markRequestEnd(pid, "summary");
      clearProgressStart(pid, "summary");
      activeSummaryStreamStoppers.delete(pid);
      finishLoadingFlag(pid);
    },
  });

  useEffect(() => {
    const pid = deepStartedFor.current;
    if (!pid) return;
    const partial = deepObj.object as Partial<PaperSummaryDeepBody> | undefined;
    if (partial && (partial.methodology || partial.main_results || partial.discussion)) {
      mergeIntoPaperSlot(pid, {
        ...(dropNulls(partial) as Partial<PaperSummary>),
        model: deepModelRef.current,
      });
    }
  }, [deepObj.object, mergeIntoPaperSlot]);

  const startDeep = useCallback(
    (pid: string) => {
      if (deepObj.isLoading) return;
      deepStartedFor.current = pid;
      deepModelRef.current = analysisModel;
      setSummaryLoadingForPaper(pid, true);
      deepObj.submit({});
    },
    [analysisModel, deepObj, setSummaryLoadingForPaper],
  );

  const runLite = useCallback(
    async (pid: string) => {
      liteAbortRef.current?.abort();
      const controller = new AbortController();
      liteAbortRef.current = controller;
      liteStartedFor.current = pid;
      setLiteLoading(true);
      setSummaryLoadingForPaper(pid, true);
      try {
        const lite = await api.getSummaryLite(pid, {
          signal: controller.signal,
          model: fastModel,
        });
        if (controller.signal.aborted) return;
        if (!hasOverview(lite)) {
          throw new Error("Summary preview returned empty. Try again.");
        }
        setSummaryError(pid, null);
        mergeIntoPaperSlot(pid, {
          ...dropNulls(lite as Record<string, unknown>) as Partial<PaperSummary>,
          model: lite.model ?? fastModel,
          created_at: Date.now(),
        });
        updateCachedAnalysis(pid, { summary_lite: lite });
        liteStartedFor.current = null;
        setLiteLoading(false);
        finishLoadingFlag(pid);
        startDeep(pid);
      } catch (e) {
        if (controller.signal.aborted) return;
        liteStartedFor.current = null;
        setLiteLoading(false);
        setSummaryError(pid, describeError(e));
        markRequestEnd(pid, "summary");
        clearProgressStart(pid, "summary");
        activeSummaryStreamStoppers.delete(pid);
        finishLoadingFlag(pid);
      } finally {
        if (liteAbortRef.current === controller) {
          liteAbortRef.current = null;
        }
      }
    },
    [
      fastModel,
      finishLoadingFlag,
      mergeIntoPaperSlot,
      setSummaryError,
      setSummaryLoadingForPaper,
      startDeep,
      updateCachedAnalysis,
    ],
  );

  const start = useCallback(() => {
    if (liteLoading || deepObj.isLoading) return;
    const pid = paperId;

    const existing = useStore.getState().summaryByPaper[pid] ?? null;
    if (hasOverview(existing) && hasDeepBody(existing)) {
      return;
    }
    if (hasOverview(existing) && !hasDeepBody(existing)) {
      markRequestStart(pid, "summary");
      activeSummaryStreamStoppers.set(pid, () => {
        liteAbortRef.current?.abort();
        deepObj.stop();
      });
      setSummaryError(pid, null);
      clearProgressStart(pid, "summary");
      startDeep(pid);
      return;
    }

    markRequestStart(pid, "summary");
    activeSummaryStreamStoppers.set(pid, () => {
      liteAbortRef.current?.abort();
      deepObj.stop();
    });
    setSummaryError(pid, null);
    clearProgressStart(pid, "summary");
    void runLite(pid);
  }, [paperId, liteLoading, deepObj, runLite, setSummaryError, startDeep]);

  useEffect(() => {
    summaryStreamStarters.set(paperId, start);
    return () => {
      summaryStreamStarters.delete(paperId);
    };
  }, [paperId, start]);

  const stop = useCallback(() => {
    liteAbortRef.current?.abort();
    deepObj.stop();
    const pid = liteStartedFor.current || deepStartedFor.current || paperId;
    liteStartedFor.current = null;
    deepStartedFor.current = null;
    setLiteLoading(false);
    markRequestEnd(pid, "summary");
    clearProgressStart(pid, "summary");
    activeSummaryStreamStoppers.delete(pid);
    finishLoadingFlag(pid);
  }, [paperId, deepObj, finishLoadingFlag]);

  return {
    start,
    stop,
    isLoading: liteLoading || deepObj.isLoading,
    error: deepObj.error,
  };
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
