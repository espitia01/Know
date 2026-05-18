"use client";

/**
 * Single source of truth for the migrated selection-stream flow.
 *
 * Replaces the duplicated streaming logic that used to live in two
 * places (`paper/[id]/page.tsx` selection handler and
 * `BottomPanel.handleFollowUp`) — both built their own
 * AbortController, parsed SSE chunks, and wrote selection state into
 * the zustand store with subtle differences.
 *
 * Wraps `experimental_useObject` against `SelectionResultSchema`
 * (Stage 2). Each `start()` call:
 *   - generates a fresh `clientKey` so threaded UI keys stay stable,
 *   - writes a provisional row into `selectionHistory`,
 *   - syncs the partial `object` into `selectionResult` + the matching
 *     history row on every render,
 *   - on completion, marks `streaming: false` and refreshes usage,
 *   - on error, writes a structured error row that the panel can
 *     display verbatim (incl. tier-cap messaging).
 *
 * Tier gating + paper ownership are enforced server-side (Python
 * /api/internal/usage/reserve), so the hook only translates the
 * structured error detail into UI strings.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import { experimental_useObject as useObject } from "@ai-sdk/react";
import { api, type SelectionAnalysisResult } from "@/lib/api";
import { SelectionResultSchema } from "@/lib/server/schemas";
import { useStore } from "@/lib/store";

export type SelectionAction = "explain" | "derive" | "followup";

export type StartArgs = {
  action: SelectionAction;
  selectedText: string;
  question?: string;
};

type StartedState = {
  clientKey: string;
  action: SelectionAction;
  selectedText: string;
  question?: string;
  model?: string;
};

function newClientKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `sel-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function describeError(error: unknown): string {
  if (!error) return "Selection failed.";
  // experimental_useObject surfaces fetch / parse failures as Error
  // instances; structured 4xx detail bodies come out as e.message
  // containing the JSON we returned. Try to JSON-parse first.
  const message = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(message) as { detail?: { code?: string; message?: string } };
    if (parsed.detail?.message) {
      const code = parsed.detail.code;
      if (code === "tier_locked" || code === "paper_cap" || code === "daily_cap" || code === "model_cap") {
        return `**Limit reached.** ${parsed.detail.message}\n\nUpgrade your plan to continue.`;
      }
      return parsed.detail.message;
    }
  } catch {
    /* not JSON; fall through */
  }
  return message || "Selection failed.";
}

export function useSelectionThread(paperId: string) {
  const setSelectionResult = useStore((s) => s.setSelectionResult);
  const setSelectionLoading = useStore((s) => s.setSelectionLoading);
  const upsertSelectionInHistory = useStore((s) => s.upsertSelectionInHistory);
  const bumpUsageRefresh = useStore((s) => s.bumpUsageRefresh);

  const startedRef = useRef<StartedState | null>(null);
  const finalizedRef = useRef<string | null>(null);

  const obj = useObject({
    id: paperId,
    api: `/api/papers/${paperId}/selection-stream`,
    schema: SelectionResultSchema,
    onError: (error) => {
      // Don't clobber state from a stale paper.
      const startedFor = useStore.getState().paper?.id;
      if (startedFor !== paperId) return;
      const started = startedRef.current;
      if (!started) return;
      const errResult: SelectionAnalysisResult = {
        action: started.action,
        selected_text: started.selectedText,
        question: started.question,
        explanation: describeError(error),
        streaming: false,
        clientKey: started.clientKey,
      };
      upsertSelectionInHistory(errResult);
      setSelectionResult(errResult);
      setSelectionLoading(false);
      finalizedRef.current = started.clientKey;
    },
    onFinish: () => {
      const started = startedRef.current;
      if (!started) return;
      // Don't double-finalize: the partial->final sync below will run on
      // the same render and we use this to refresh usage exactly once.
      if (finalizedRef.current === started.clientKey) return;
      bumpUsageRefresh();
    },
  });

  // Sync partial object → store on every paint. We avoid running for
  // the wrong paper (user switched mid-stream), and we coalesce
  // streaming/done updates into the same shape the existing UI
  // (SelectionResultPanel) already renders against.
  useEffect(() => {
    const started = startedRef.current;
    if (!started) return;
    const currentPaper = useStore.getState().paper?.id;
    if (currentPaper !== paperId) return;

    const partial = obj.object as
      | {
          action?: SelectionAction;
          body?: string;
          assumptions?: SelectionAnalysisResult["assumptions"];
          starting_point?: string;
          final_result?: string;
          steps?: SelectionAnalysisResult["steps"];
        }
      | undefined;

    const isStillStreaming = obj.isLoading;
    if (!partial && isStillStreaming) return;

    const result: SelectionAnalysisResult = {
      action: started.action,
      selected_text: started.selectedText,
      question: started.question,
      explanation: partial?.body ?? "",
      assumptions: partial?.assumptions,
      starting_point: partial?.starting_point,
      final_result: partial?.final_result,
      steps: partial?.steps as SelectionAnalysisResult["steps"],
      streaming: isStillStreaming,
      clientKey: started.clientKey,
      model: started.model,
      created_at: isStillStreaming ? undefined : Date.now(),
    };

    upsertSelectionInHistory(result);
    setSelectionResult(result);
    if (!isStillStreaming) finalizedRef.current = started.clientKey;
  }, [obj.object, obj.isLoading, paperId, setSelectionResult, upsertSelectionInHistory]);

  const start = useCallback(
    (args: StartArgs) => {
      const trimmed = args.selectedText.trim();
      if (!trimmed) return;
      const clientKey = newClientKey();
      startedRef.current = {
        clientKey,
        action: args.action,
        selectedText: trimmed,
        question: args.question,
      };
      finalizedRef.current = null;
      void api.getSettings().then((s) => {
        if (startedRef.current?.clientKey === clientKey) {
          startedRef.current = { ...startedRef.current, model: s.fast_model };
        }
      });

      const provisional: SelectionAnalysisResult = {
        action: args.action,
        selected_text: trimmed,
        question: args.question,
        explanation: "",
        streaming: true,
        clientKey,
      };
      upsertSelectionInHistory(provisional);
      setSelectionResult(provisional);
      setSelectionLoading(false);

      obj.submit({
        action: args.action,
        selected_text: trimmed,
        question: args.question,
      });
    },
    [obj, setSelectionLoading, setSelectionResult, upsertSelectionInHistory],
  );

  const abort = useCallback(() => {
    obj.stop();
  }, [obj]);

  // Stable object identity — consumers put this in useEffect deps and
  // we don't want every render to retrigger downstream effects.
  return useMemo(
    () => ({ start, abort, error: obj.error, isLoading: obj.isLoading }),
    [start, abort, obj.error, obj.isLoading],
  );
}
