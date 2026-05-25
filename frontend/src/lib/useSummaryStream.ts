"use client";

/**
 * Single-phase summary orchestrator.
 *
 * The earlier two-phase pipeline (haiku fast preview → sonnet deep
 * dive) caused the model badge to flicker mid-render and confused
 * users who expected their Settings `analysis_model` to be the one
 * doing the work. We now do exactly one stream call, scoped to the
 * user's analysis model, against `/api/papers/[id]/summary-stream`
 * (schema `PaperSummaryDeepSchema`, which now contains every field
 * the panel renders). Persistence still lives under
 * `cached_analysis.summary_deep` so legacy reads keep working.
 *
 * The Python `/api/papers/{id}/summary` batch fallback was retired
 * after Railway's edge proxy started killing its long-running
 * non-streaming response with a 502 at ~20s. The Vercel streaming
 * route now returns typed JSON errors for every failure mode it
 * can detect (missing key, gateway 4xx/5xx, missing paper text,
 * usage cap), so users see real errors instead of a 502 from a
 * doomed fallback request.
 */

import { useCallback, useEffect, useRef } from "react";
import { experimental_useObject as useObject } from "@ai-sdk/react";
import {
  PaperSummaryDeepSchema,
  type PaperSummary,
  type PaperSummaryDeep,
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
  try {
    const parsed = JSON.parse(message) as {
      detail?: { code?: string; message?: string; model?: string };
    };
    if (parsed.detail?.message) {
      const code = parsed.detail.code ? `[${parsed.detail.code}] ` : "";
      return `${code}${parsed.detail.message}`;
    }
  } catch {
    /* not JSON — fall through */
  }
  if (message.includes("paper_text_unavailable")) {
    return "Paper text is not ready yet. Wait for parsing to finish, then try again.";
  }
  if (message.includes("usage_unavailable") || message.includes("usage tracking")) {
    return "Usage tracking is temporarily unavailable. If this persists, confirm migration 023 is applied on Supabase.";
  }
  if (message.includes("provider_error") || message.includes("Provider error")) {
    return "The analysis model could not run. Check provider keys / AI Gateway configuration, or pick another model in Settings.";
  }
  return message || "Summary generation failed. Try again.";
}

function hasOverview(value: Partial<PaperSummary> | null | undefined): boolean {
  return typeof value?.overview === "string" && value.overview.trim().length > 0;
}

function hasBody(value: Partial<PaperSummary> | null | undefined): boolean {
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
  const { analysisModel } = useUserSettings();

  const setSummaryForPaper = useStore((s) => s.setSummaryForPaper);
  const setSummaryError = useStore((s) => s.setSummaryError);
  const setSummaryLoadingForPaper = useStore((s) => s.setSummaryLoadingForPaper);
  const updateCachedAnalysis = useStore((s) => s.updateCachedAnalysis);

  const startedFor = useRef<string | null>(null);
  const partialRef = useRef<Partial<PaperSummaryDeep> | undefined>(undefined);
  const modelRef = useRef<string | undefined>(undefined);

  const mergeIntoPaperSlot = useCallback(
    (pid: string, patch: Partial<PaperSummary>) => {
      const prev = useStore.getState().summaryByPaper[pid] ?? null;
      const next = mergeSummary(prev, patch);
      const prevJson = prev ? JSON.stringify(prev) : "";
      const nextJson = JSON.stringify(next);
      if (prevJson === nextJson) return;
      setSummaryForPaper(pid, next);
    },
    [setSummaryForPaper],
  );

  const finishSummary = useCallback(
    (pid: string, summary: PaperSummaryDeep) => {
      const withMeta: PaperSummary = {
        ...summary,
        model: summary.model ?? modelRef.current,
        created_at: summary.created_at ?? Date.now(),
      };
      mergeIntoPaperSlot(pid, withMeta);
      const merged = useStore.getState().summaryByPaper[pid] ?? withMeta;
      updateCachedAnalysis(pid, {
        summary_deep: withMeta,
        summary: merged,
      });
      setSummaryError(pid, null);
      autoAnalyzedPapers.add(`${pid}:summary`);
    },
    [mergeIntoPaperSlot, setSummaryError, updateCachedAnalysis],
  );

  const cleanup = useCallback(
    (pid: string) => {
      startedFor.current = null;
      markRequestEnd(pid, "summary");
      clearProgressStart(pid, "summary");
      activeSummaryStreamStoppers.delete(pid);
      setSummaryLoadingForPaper(pid, false);
    },
    [setSummaryLoadingForPaper],
  );

  const obj = useObject({
    id: `${paperId}-summary`,
    api: `/api/papers/${paperId}/summary-stream`,
    schema: PaperSummaryDeepSchema,
    credentials: "include",
    onError: (error) => {
      const pid = startedFor.current;
      if (!pid) return;
      setSummaryError(pid, describeError(error));
      cleanup(pid);
    },
    onFinish: ({ object, error }) => {
      const pid = startedFor.current;
      if (!pid) return;
      const candidate = (object ?? partialRef.current) as
        | Partial<PaperSummaryDeep>
        | undefined;
      if (hasBody(candidate)) {
        finishSummary(pid, candidate as PaperSummaryDeep);
        cleanup(pid);
        return;
      }
      // No methodology streamed — surface whatever upstream error we got
      // (or a generic empty-result message). The Python /summary fallback
      // was retired because Railway's edge proxy 502'd it at ~20s.
      const msg = error
        ? describeError(error)
        : "Summary generation returned empty results. Try again.";
      setSummaryError(pid, msg);
      cleanup(pid);
    },
  });

  partialRef.current = obj.object as Partial<PaperSummaryDeep> | undefined;
  const lastMergeKey = useRef("");

  useEffect(() => {
    const pid = startedFor.current;
    if (!pid) return;
    const partial = obj.object as Partial<PaperSummaryDeep> | undefined;
    if (!obj.isLoading && !partial) {
      startedFor.current = null;
      return;
    }
    const hasAny =
      !!partial &&
      (partial.overview ||
        partial.tl_dr ||
        (partial.key_contributions && partial.key_contributions.length) ||
        partial.motivation ||
        partial.methodology ||
        partial.main_results ||
        partial.discussion);
    if (!hasAny) {
      if (!obj.isLoading) startedFor.current = null;
      return;
    }
    const mergeKey = JSON.stringify(partial);
    if (mergeKey === lastMergeKey.current) return;
    lastMergeKey.current = mergeKey;
    mergeIntoPaperSlot(pid, { ...partial, model: modelRef.current } as Partial<PaperSummary>);
  }, [obj.object, obj.isLoading, mergeIntoPaperSlot]);

  const start = useCallback(() => {
    if (obj.isLoading) return;
    const pid = paperId;

    const existing = useStore.getState().summaryByPaper[pid] ?? null;
    if (hasOverview(existing) && hasBody(existing)) {
      return;
    }

    startedFor.current = pid;
    modelRef.current = analysisModel;
    lastMergeKey.current = "";
    markRequestStart(pid, "summary");
    activeSummaryStreamStoppers.set(pid, () => {
      obj.stop();
    });
    setSummaryError(pid, null);
    setSummaryLoadingForPaper(pid, true);
    clearProgressStart(pid, "summary");
    obj.submit({});
  }, [
    paperId,
    analysisModel,
    obj,
    setSummaryError,
    setSummaryLoadingForPaper,
  ]);

  useEffect(() => {
    summaryStreamStarters.set(paperId, start);
    return () => {
      summaryStreamStarters.delete(paperId);
    };
  }, [paperId, start]);

  const stop = useCallback(() => {
    obj.stop();
    const pid = startedFor.current || paperId;
    cleanup(pid);
  }, [paperId, obj, cleanup]);

  return {
    start,
    stop,
    isLoading: obj.isLoading,
    error: obj.error,
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
