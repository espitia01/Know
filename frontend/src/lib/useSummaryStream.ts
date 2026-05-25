"use client";

/**
 * Summary streaming on Railway.
 *
 * Two SSE calls in sequence:
 *   1. summary-lite-stream — fast preview (overview, tl_dr, key contributions, equations)
 *   2. summary-deep-stream — methodology / results / discussion / limitations / etc.
 *
 * Each emits progressive `object` events the client merges into the
 * per-paper summary slot, so users see fields fill in token-by-token
 * (ChatGPT-style). On any 405 (stale Railway deploy) we fall back to
 * the legacy POST /summary which has been deployed forever.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type PaperSummary } from "@/lib/api";
import {
  hasSummaryDeepBody,
  hasSummaryOverview,
  summaryIsComplete,
} from "@/lib/summaryState";
import { consumeObjectSse } from "@/lib/objectSse";
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

function isMethodNotAllowed(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("Method Not Allowed") ||
    msg.includes("405") ||
    msg.includes("Backend rejected the request method") ||
    msg.includes("Not Found") ||
    msg.includes("404")
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

async function streamSummaryPhase(
  paperId: string,
  phase: "lite" | "deep",
  model: string,
  signal: AbortSignal,
  onObject: (partial: Partial<PaperSummary>) => void,
): Promise<Partial<PaperSummary>> {
  const fetcher = phase === "lite" ? api.streamSummaryLite : api.streamSummaryDeep;
  const res = await fetcher(paperId, { signal, model });
  if (!res.ok || !res.body) {
    let message = `Summary stream failed (${res.status})`;
    const detail = await res.text().catch(() => "");
    try {
      const parsed = JSON.parse(detail) as { detail?: { message?: string } | string };
      const m =
        typeof parsed.detail === "string" ? parsed.detail : parsed.detail?.message;
      if (m) message = m;
    } catch {
      if (detail) message = detail;
    }
    if (res.status === 405 || res.status === 404) {
      throw new Error(`Method Not Allowed (${res.status}): ${message}`);
    }
    throw new Error(message);
  }
  let last: Partial<PaperSummary> = {};
  let streamError: string | null = null;
  await consumeObjectSse<Partial<PaperSummary>>(
    res.body.getReader(),
    signal,
    {
      onObject: (partial) => {
        last = partial;
        onObject(partial);
      },
      onDone: (final) => {
        last = final ?? last;
      },
      onError: (msg) => {
        streamError = msg;
      },
    },
  );
  if (streamError) throw new Error(streamError);
  return last;
}

export function useSummaryStream(paperId: string) {
  const { analysisModel, fastModel } = useUserSettings();

  const setSummaryForPaper = useStore((s) => s.setSummaryForPaper);
  const setSummaryError = useStore((s) => s.setSummaryError);
  const setSummaryLoadingForPaper = useStore((s) => s.setSummaryLoadingForPaper);
  const updateCachedAnalysis = useStore((s) => s.updateCachedAnalysis);

  const abortRef = useRef<AbortController | null>(null);
  const autoRanRef = useRef(false);
  const autoRanForRef = useRef<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (autoRanForRef.current !== paperId) {
      autoRanRef.current = false;
      autoRanForRef.current = paperId;
    }
  }, [paperId]);

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

      const runLegacyFallback = async () => {
        const full = await api.getSummary(pid);
        if (controller.signal.aborted) return;
        if (!hasSummaryOverview(full)) {
          throw new Error("Summary returned empty. Try again.");
        }
        mergeIntoPaperSlot(pid, {
          ...(dropNulls(full as Record<string, unknown>) as Partial<PaperSummary>),
          model: full.model ?? analysisModel,
          created_at: Date.now(),
        });
        updateCachedAnalysis(pid, {
          summary: useStore.getState().summaryByPaper[pid] ?? (full as PaperSummary),
          summary_lite: full as PaperSummary,
          summary_deep: hasSummaryDeepBody(full) ? (full as PaperSummary) : undefined,
        });
      };

      try {
        if (phase === "full") {
          let liteFinal: Partial<PaperSummary> = {};
          try {
            liteFinal = await streamSummaryPhase(
              pid, "lite", fastModel, controller.signal,
              (partial) => mergeIntoPaperSlot(pid, partial),
            );
          } catch (err) {
            if (isMethodNotAllowed(err)) {
              await runLegacyFallback();
              setSummaryError(pid, null);
              autoAnalyzedPapers.add(`${pid}:summary`);
              return;
            }
            throw err;
          }
          if (controller.signal.aborted) return;
          if (!hasSummaryOverview(liteFinal)) {
            throw new Error("Summary preview returned empty. Try again.");
          }
          updateCachedAnalysis(pid, {
            summary: useStore.getState().summaryByPaper[pid] ?? (liteFinal as PaperSummary),
            summary_lite: liteFinal as PaperSummary,
          });
        }

        let deepFinal: Partial<PaperSummary> = {};
        try {
          deepFinal = await streamSummaryPhase(
            pid, "deep", analysisModel, controller.signal,
            (partial) => mergeIntoPaperSlot(pid, partial),
          );
        } catch (err) {
          if (isMethodNotAllowed(err)) {
            await runLegacyFallback();
            setSummaryError(pid, null);
            autoAnalyzedPapers.add(`${pid}:summary`);
            return;
          }
          throw err;
        }
        if (controller.signal.aborted) return;
        if (!hasSummaryDeepBody(deepFinal)) {
          throw new Error("Summary deep section returned empty. Try again.");
        }

        mergeIntoPaperSlot(pid, {
          ...(dropNulls(deepFinal as Record<string, unknown>) as Partial<PaperSummary>),
          model: deepFinal.model ?? analysisModel,
          created_at: Date.now(),
        });
        updateCachedAnalysis(pid, {
          summary: useStore.getState().summaryByPaper[pid] ?? (deepFinal as PaperSummary),
          summary_deep: deepFinal as PaperSummary,
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
