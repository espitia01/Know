"use client";

/**
 * Summary generation on Railway — batch-first for reliability.
 *
 * 1. POST /summary-lite  → merge immediately (overview appears)
 * 2. POST /summary-deep  → merge (methodology / results / discussion)
 *
 * On 405/404 (stale deploy) or batch failure → legacy POST /summary.
 *
 * Aborts in-flight work when the user switches papers so multiple
 * concurrent LLM calls + KaTeX re-renders don't freeze the tab.
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
  markSummaryAttemptFailed,
  clearProgressStart,
} from "@/lib/analysisState";

function describeError(error: unknown): string {
  if (!error) return "Summary generation failed. Try again.";
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("OpenAI returned an empty response")) {
    return "The model returned an empty response. Try a different model in Settings, or retry.";
  }
  try {
    const parsed = JSON.parse(message) as {
      detail?: { code?: string; message?: string } | string;
    };
    if (typeof parsed.detail === "string") return parsed.detail;
    if (parsed.detail?.message) {
      const code = parsed.detail.code ? `[${parsed.detail.code}] ` : "";
      return `${code}${parsed.detail.message}`;
    }
  } catch {
    /* not JSON */
  }
  return message || "Summary generation failed. Try again.";
}

function isUnavailableEndpoint(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("Method Not Allowed") ||
    msg.includes("405") ||
    msg.includes("404") ||
    msg.includes("Backend rejected the request method") ||
    msg.includes("Not Found")
  );
}

function dropNulls<T extends Record<string, unknown>>(value: Partial<T>): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === null || v === undefined) continue;
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

/** Shallow-enough equality to skip store writes during streaming merges. */
function summaryPatchEqual(
  prev: PaperSummary | null,
  next: PaperSummary,
): boolean {
  if (!prev) return false;
  for (const key of Object.keys(next) as (keyof PaperSummary)[]) {
    const a = prev[key];
    const b = next[key];
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      if (a.some((v, i) => v !== b[i])) return false;
      continue;
    }
    if (a !== b) return false;
  }
  return true;
}

export function useSummaryStream(paperId: string) {
  const { analysisModel, fastModel } = useUserSettings();
  const analysisModelRef = useRef(analysisModel);
  const fastModelRef = useRef(fastModel);
  analysisModelRef.current = analysisModel;
  fastModelRef.current = fastModel;

  const setSummaryForPaper = useStore((s) => s.setSummaryForPaper);
  const setSummaryError = useStore((s) => s.setSummaryError);
  const setSummaryLoadingForPaper = useStore((s) => s.setSummaryLoadingForPaper);
  const updateCachedAnalysis = useStore((s) => s.updateCachedAnalysis);

  const abortRef = useRef<AbortController | null>(null);
  const inflightForRef = useRef<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Abort when switching papers or unmounting — prevents N concurrent
  // summary calls + KaTeX re-renders from freezing the tab.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
      if (inflightForRef.current) {
        markRequestEnd(inflightForRef.current, "summary");
        activeSummaryStreamStoppers.delete(inflightForRef.current);
        inflightForRef.current = null;
      }
    };
  }, [paperId]);

  const mergeIntoPaperSlot = useCallback(
    (pid: string, patch: Partial<PaperSummary>) => {
      const prev = useStore.getState().summaryByPaper[pid] ?? null;
      const next = mergeSummary(prev, patch);
      if (summaryPatchEqual(prev, next as PaperSummary)) return;
      setSummaryForPaper(pid, next as PaperSummary);
    },
    [setSummaryForPaper],
  );

  const runLegacyFallback = useCallback(
    async (pid: string, controller: AbortController) => {
      const full = await api.getSummary(pid, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!hasSummaryOverview(full)) {
        throw new Error("Summary returned empty. Try again.");
      }
      mergeIntoPaperSlot(pid, {
        ...(dropNulls(full as Record<string, unknown>) as Partial<PaperSummary>),
        model: full.model ?? analysisModelRef.current,
        created_at: Date.now(),
      });
      updateCachedAnalysis(pid, {
        summary: useStore.getState().summaryByPaper[pid] ?? (full as PaperSummary),
        summary_lite: full as PaperSummary,
        summary_deep: hasSummaryDeepBody(full) ? (full as PaperSummary) : undefined,
      });
    },
    [mergeIntoPaperSlot, updateCachedAnalysis],
  );

  const runGenerate = useCallback(
    async (pid: string, phase: "full" | "deep") => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      inflightForRef.current = pid;
      setIsLoading(true);
      setSummaryLoadingForPaper(pid, true);
      setSummaryError(pid, null);
      markRequestStart(pid, "summary");
      activeSummaryStreamStoppers.set(pid, () => controller.abort());

      const fast = fastModelRef.current;
      const analysis = analysisModelRef.current;

      try {
        if (phase === "full") {
          let lite: PaperSummary;
          try {
            lite = await api.getSummaryLite(pid, {
              signal: controller.signal,
              model: fast,
            });
          } catch (err) {
            if (isUnavailableEndpoint(err)) {
              await runLegacyFallback(pid, controller);
              setSummaryError(pid, null);
              autoAnalyzedPapers.add(`${pid}:summary`);
              return;
            }
            throw err;
          }
          if (controller.signal.aborted) return;
          if (!hasSummaryOverview(lite)) {
            throw new Error("Summary preview returned empty. Try again.");
          }
          mergeIntoPaperSlot(pid, dropNulls(lite as Record<string, unknown>));
          updateCachedAnalysis(pid, {
            summary: useStore.getState().summaryByPaper[pid] ?? (lite as PaperSummary),
            summary_lite: lite as PaperSummary,
          });
        }

        let deep: PaperSummary;
        try {
          deep = await api.getSummaryDeep(pid, {
            signal: controller.signal,
            model: analysis,
          });
        } catch (err) {
          if (isUnavailableEndpoint(err)) {
            await runLegacyFallback(pid, controller);
            setSummaryError(pid, null);
            autoAnalyzedPapers.add(`${pid}:summary`);
            return;
          }
          throw err;
        }
        if (controller.signal.aborted) return;
        if (!hasSummaryDeepBody(deep)) {
          throw new Error("Summary deep section returned empty. Try again.");
        }

        mergeIntoPaperSlot(pid, {
          ...(dropNulls(deep as Record<string, unknown>) as Partial<PaperSummary>),
          model: deep.model ?? analysis,
          created_at: Date.now(),
        });
        updateCachedAnalysis(pid, {
          summary: useStore.getState().summaryByPaper[pid] ?? (deep as PaperSummary),
          summary_deep: deep as PaperSummary,
        });
        setSummaryError(pid, null);
        autoAnalyzedPapers.add(`${pid}:summary`);
      } catch (e) {
        if (controller.signal.aborted) return;
        markSummaryAttemptFailed(pid);
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
        if (inflightForRef.current === pid) {
          inflightForRef.current = null;
        }
        setIsLoading(false);
        setSummaryLoadingForPaper(pid, false);
        markRequestEnd(pid, "summary");
        clearProgressStart(pid, "summary");
        activeSummaryStreamStoppers.delete(pid);
      }
    },
    [
      mergeIntoPaperSlot,
      runLegacyFallback,
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
