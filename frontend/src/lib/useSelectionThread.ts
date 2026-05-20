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
import type { SelectionAnalysisResult } from "@/lib/api";
import { SelectionResultSchema } from "@/lib/server/schemas";
import { useStore } from "@/lib/store";
import { useUserSettings } from "@/lib/UserSettingsContext";

export type SelectionAction = "explain" | "derive" | "followup";

export type StartArgs = {
  action: SelectionAction;
  selectedText: string;
  question?: string;
  /** Per-request override (follow-up composer); validated server-side. */
  model?: string;
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

const INCOMPLETE_SELECTION_MSG =
  "The model didn't return a complete answer. This can happen when the output is cut off or fails validation. Please try again.";

type SelectionPartial = {
  action?: SelectionAction;
  body?: string;
  assumptions?: SelectionAnalysisResult["assumptions"];
  starting_point?: string;
  final_result?: string;
  steps?: SelectionAnalysisResult["steps"];
};

function hasSelectionContent(partial: SelectionPartial | undefined | null): boolean {
  if (!partial) return false;
  if (typeof partial.body === "string" && partial.body.trim().length > 0) return true;
  if (typeof partial.final_result === "string" && partial.final_result.trim().length > 0) {
    return true;
  }
  return Array.isArray(partial.steps) && partial.steps.length > 0;
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
  const { fastModel } = useUserSettings();
  // Per-paper writers — late results from a slow Derive on paper A land
  // in A's slot even if the user has switched to paper B by then.
  const setSelectionResultForPaper = useStore((s) => s.setSelectionResultForPaper);
  const setSelectionLoadingForPaper = useStore((s) => s.setSelectionLoadingForPaper);
  const upsertSelectionInHistoryForPaper = useStore((s) => s.upsertSelectionInHistoryForPaper);
  const bumpUsageRefresh = useStore((s) => s.bumpUsageRefresh);

  const startedRef = useRef<StartedState | null>(null);
  const finalizedRef = useRef<string | null>(null);
  const lastSyncKey = useRef("");

  const writeErrorResult = useCallback(
    (started: StartedState, message: string) => {
      const errResult: SelectionAnalysisResult = {
        action: started.action,
        selected_text: started.selectedText,
        question: started.question,
        explanation: message,
        streaming: false,
        clientKey: started.clientKey,
        model: started.model,
      };
      upsertSelectionInHistoryForPaper(paperId, errResult);
      setSelectionResultForPaper(paperId, errResult);
      setSelectionLoadingForPaper(paperId, false);
      finalizedRef.current = started.clientKey;
      startedRef.current = null;
      lastSyncKey.current = "";
    },
    [paperId, setSelectionResultForPaper, setSelectionLoadingForPaper, upsertSelectionInHistoryForPaper],
  );

  const obj = useObject({
    id: paperId,
    api: `/api/papers/${paperId}/selection-stream`,
    schema: SelectionResultSchema,
    onError: (error) => {
      const started = startedRef.current;
      if (!started) return;
      writeErrorResult(started, describeError(error));
    },
    onFinish: ({ object, error }) => {
      const started = startedRef.current;
      if (!started) return;
      if (finalizedRef.current === started.clientKey) return;

      if (error) {
        writeErrorResult(started, describeError(error));
        return;
      }

      const partial = object as SelectionPartial | undefined;
      if (!hasSelectionContent(partial)) {
        writeErrorResult(started, INCOMPLETE_SELECTION_MSG);
        return;
      }

      bumpUsageRefresh();
    },
  });

  // Sync partial object → store on every paint. Writes target the
  // hook's own `paperId` (not whichever paper is currently active),
  // so panel B never sees A's stream and a slow result for A lands
  // correctly once the user returns.
  useEffect(() => {
    const started = startedRef.current;
    if (!started) return;

    // Stream already finalized for this clientKey — stop syncing. Without
    // this guard (and clearing startedRef below) every new `obj.object`
    // reference from useObject re-writes the store and triggers React #185.
    if (finalizedRef.current === started.clientKey && !obj.isLoading) {
      return;
    }

    const partial = obj.object as SelectionPartial | undefined;

    const isStillStreaming = obj.isLoading;
    if (!partial && isStillStreaming) return;

    if (!isStillStreaming && !hasSelectionContent(partial)) {
      if (finalizedRef.current !== started.clientKey) {
        const msg = obj.error ? describeError(obj.error) : INCOMPLETE_SELECTION_MSG;
        writeErrorResult(started, msg);
      }
      return;
    }

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

    const syncKey = JSON.stringify(result);
    if (syncKey === lastSyncKey.current) {
      if (!isStillStreaming) {
        finalizedRef.current = started.clientKey;
        startedRef.current = null;
      }
      return;
    }
    lastSyncKey.current = syncKey;

    upsertSelectionInHistoryForPaper(paperId, result);
    setSelectionResultForPaper(paperId, result);
    if (!isStillStreaming) {
      finalizedRef.current = started.clientKey;
      startedRef.current = null;
    }
  }, [
    obj.object,
    obj.isLoading,
    obj.error,
    paperId,
    setSelectionResultForPaper,
    upsertSelectionInHistoryForPaper,
    writeErrorResult,
  ]);

  const start = useCallback(
    (args: StartArgs) => {
      const trimmed = args.selectedText.trim();
      if (!trimmed) return;
      const clientKey = newClientKey();
      const provisionalModel = args.model ?? fastModel;
      startedRef.current = {
        clientKey,
        action: args.action,
        selectedText: trimmed,
        question: args.question,
        model: provisionalModel,
      };
      finalizedRef.current = null;
      lastSyncKey.current = "";

      const provisional: SelectionAnalysisResult = {
        action: args.action,
        selected_text: trimmed,
        question: args.question,
        explanation: "",
        streaming: true,
        clientKey,
        model: provisionalModel,
      };
      upsertSelectionInHistoryForPaper(paperId, provisional);
      setSelectionResultForPaper(paperId, provisional);
      setSelectionLoadingForPaper(paperId, false);

      obj.submit({
        action: args.action,
        selected_text: trimmed,
        question: args.question,
        ...(args.model ? { model: args.model } : {}),
      });
    },
    [obj, fastModel, paperId, setSelectionLoadingForPaper, setSelectionResultForPaper, upsertSelectionInHistoryForPaper],
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
