"use client";

/**
 * Two-phase summary (lite → deep) so each Vercel invocation gets a fresh
 * heap. A single monolithic `PaperSummaryDeep` stream was OOMing at ~1.8 GB.
 *
 * Lite: `/summary-lite-stream` (small schema, fast model).
 * Deep: `/summary-stream` (body-only schema, analysis model).
 */

import { useCallback, useEffect, useRef } from "react";
import { experimental_useObject as useObject } from "@ai-sdk/react";
import type { PaperSummary } from "@/lib/api";
import {
  PaperSummaryDeepBodySchema,
  PaperSummaryLiteSchema,
  type PaperSummaryDeepBody,
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

function describeError(error: unknown): string {
  if (!error) return "Summary generation failed. Try again.";
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("<!DOCTYPE html") ||
    message.includes("Internal Server Error") ||
    message.includes("SIGABRT") ||
    message.includes("heap out of memory")
  ) {
    return "Summary crashed on the server (out of memory). Retry after deploy; if it persists, try Haiku/Mistral Small or a shorter paper.";
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

function mergeSummary(
  prev: PaperSummary | null,
  patch: Partial<PaperSummary>,
): PaperSummary {
  const merged = { ...(prev ?? {}), ...patch };
  return dropNulls(merged) as PaperSummary;
}

function dropNulls<T extends Record<string, unknown>>(value: Partial<T>): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === null) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

export function useSummaryStream(paperId: string) {
  const { analysisModel, fastModel } = useUserSettings();

  const setSummaryForPaper = useStore((s) => s.setSummaryForPaper);
  const setSummaryError = useStore((s) => s.setSummaryError);
  const setSummaryLoadingForPaper = useStore((s) => s.setSummaryLoadingForPaper);
  const updateCachedAnalysis = useStore((s) => s.updateCachedAnalysis);

  const liteStartedFor = useRef<string | null>(null);
  const deepStartedFor = useRef<string | null>(null);
  const liteModelRef = useRef<string | undefined>(undefined);
  const deepModelRef = useRef<string | undefined>(undefined);

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

  const finishLite = useCallback(
    (pid: string, summary: PaperSummaryLite) => {
      setSummaryError(pid, null);
      mergeIntoPaperSlot(pid, dropNulls(summary) as Partial<PaperSummary>);
      updateCachedAnalysis(pid, {
        summary_lite: { ...summary, model: liteModelRef.current },
      });
    },
    [mergeIntoPaperSlot, setSummaryError, updateCachedAnalysis],
  );

  const finishDeep = useCallback(
    (pid: string, summary: PaperSummaryDeepBody) => {
      mergeIntoPaperSlot(pid, {
        ...(dropNulls(summary) as Partial<PaperSummary>),
        model: deepModelRef.current,
      });
      const merged = useStore.getState().summaryByPaper[pid];
      updateCachedAnalysis(pid, {
        summary_deep: { ...summary, model: deepModelRef.current },
        summary: merged ?? { ...summary, model: deepModelRef.current },
      });
      setSummaryError(pid, null);
      autoAnalyzedPapers.add(`${pid}:summary`);
    },
    [mergeIntoPaperSlot, setSummaryError, updateCachedAnalysis],
  );

  const liteObj = useObject({
    id: `${paperId}-lite`,
    api: `/api/papers/${paperId}/summary-lite-stream`,
    schema: PaperSummaryLiteSchema,
    credentials: "include",
    onError: (error) => {
      const pid = liteStartedFor.current;
      liteStartedFor.current = null;
      if (!pid) return;
      setSummaryError(pid, describeError(error));
      finishLoadingFlag(pid);
    },
    onFinish: ({ object, error }) => {
      const pid = liteStartedFor.current;
      liteStartedFor.current = null;
      if (!pid) return;
      const candidate = object as Partial<PaperSummaryLite> | undefined;
      if (hasOverview(candidate)) {
        finishLite(pid, candidate as PaperSummaryLite);
        finishLoadingFlag(pid);
        startDeepRef.current(pid);
        return;
      }
      setSummaryError(
        pid,
        error ? describeError(error) : "Summary preview returned empty. Try again.",
      );
      finishLoadingFlag(pid);
    },
  });

  const startDeepRef = useRef<(pid: string) => void>(() => {});

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
        finishDeep(pid, candidate as PaperSummaryDeepBody);
        markRequestEnd(pid, "summary");
        clearProgressStart(pid, "summary");
        activeSummaryStreamStoppers.delete(pid);
        finishLoadingFlag(pid);
        return;
      }
      const existing = useStore.getState().summaryByPaper[pid];
      if (!hasOverview(existing)) {
        setSummaryError(
          pid,
          error ? describeError(error) : "Summary deep section returned empty. Try again.",
        );
      } else {
        setSummaryError(
          pid,
          error
            ? `Overview loaded, but the deep dive failed: ${describeError(error)}`
            : "Overview loaded, but methodology did not stream. Try again.",
        );
      }
      markRequestEnd(pid, "summary");
      clearProgressStart(pid, "summary");
      activeSummaryStreamStoppers.delete(pid);
      finishLoadingFlag(pid);
    },
  });

  useEffect(() => {
    const pid = liteStartedFor.current;
    if (!pid) return;
    const partial = liteObj.object as Partial<PaperSummaryLite> | undefined;
    if (partial && (partial.overview || partial.tl_dr || partial.key_contributions?.length)) {
      mergeIntoPaperSlot(pid, {
        ...(dropNulls(partial) as Partial<PaperSummary>),
        model: liteModelRef.current,
      });
    }
  }, [liteObj.object, mergeIntoPaperSlot]);

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

  startDeepRef.current = startDeep;

  const start = useCallback(() => {
    if (liteObj.isLoading || deepObj.isLoading) return;
    const pid = paperId;

    const existing = useStore.getState().summaryByPaper[pid] ?? null;
    if (hasOverview(existing) && hasDeepBody(existing)) {
      return;
    }
    if (hasOverview(existing) && !hasDeepBody(existing)) {
      markRequestStart(pid, "summary");
      activeSummaryStreamStoppers.set(pid, () => {
        deepObj.stop();
      });
      setSummaryError(pid, null);
      clearProgressStart(pid, "summary");
      startDeep(pid);
      return;
    }

    liteStartedFor.current = pid;
    liteModelRef.current = fastModel;
    markRequestStart(pid, "summary");
    activeSummaryStreamStoppers.set(pid, () => {
      liteObj.stop();
      deepObj.stop();
    });
    setSummaryError(pid, null);
    setSummaryLoadingForPaper(pid, true);
    clearProgressStart(pid, "summary");
    liteObj.submit({});
  }, [
    paperId,
    fastModel,
    liteObj,
    deepObj,
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
    liteObj.stop();
    deepObj.stop();
    const pid = liteStartedFor.current || deepStartedFor.current || paperId;
    liteStartedFor.current = null;
    deepStartedFor.current = null;
    markRequestEnd(pid, "summary");
    clearProgressStart(pid, "summary");
    activeSummaryStreamStoppers.delete(pid);
    finishLoadingFlag(pid);
  }, [paperId, liteObj, deepObj, finishLoadingFlag]);

  return {
    start,
    stop,
    isLoading: liteObj.isLoading || deepObj.isLoading,
    error: liteObj.error ?? deepObj.error,
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
