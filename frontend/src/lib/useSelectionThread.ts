"use client";

/**
 * Selection explain / derive / follow-up — uses the migrated Vercel
 * `selection-stream` route via `useObject` so partial JSON streams in
 * the same way Summary does.
 *
 * The previous Python batch implementation only worked with Anthropic
 * because Mistral and OpenAI returned prose-wrapped JSON that the
 * batch's `_safe_parse_json` couldn't recover from. The Vercel route
 * uses `streamObject` with `SelectionResultSchema`, which works across
 * all providers via Vercel AI Gateway / structured-output adapters.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { experimental_useObject as useObject } from "@ai-sdk/react";
import { useStore } from "@/lib/store";
import { useUserSettings } from "@/lib/UserSettingsContext";
import { SelectionResultSchema, type SelectionResult } from "@/lib/server/schemas";
import type { SelectionAnalysisResult } from "@/lib/api";

export type SelectionAction = "explain" | "derive" | "followup";

export type StartArgs = {
  action: SelectionAction;
  selectedText: string;
  question?: string;
  model?: string;
  regions?: SelectionAnalysisResult["regions"];
  /** Base64 PNG of the selection — sent to vision when text is garbled math. */
  imageBase64?: string;
};

type StartedState = {
  clientKey: string;
  action: SelectionAction;
  selectedText: string;
  question?: string;
  model?: string;
  regions?: SelectionAnalysisResult["regions"];
};

function newClientKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `sel-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function describeError(error: unknown): string {
  if (!error) return "Selection failed.";
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
  if (message.includes("provider_error")) {
    return "The selected model could not run. Pick another in the menu or try again.";
  }
  if (message.includes("usage_unavailable")) {
    return "Usage tracking is temporarily unavailable. Try again in a moment.";
  }
  if (message.includes("tier_locked") || message.includes("paper_cap")) {
    return `**Limit reached.** ${message}\n\nUpgrade your plan to continue.`;
  }
  return message || "Selection failed.";
}

function coerceAssumptions(
  raw: SelectionResult["assumptions"] | null | undefined,
): SelectionAnalysisResult["assumptions"] {
  if (!raw) return undefined;
  return raw.map((a) => ({
    statement: a.statement ?? "",
    type: a.type ?? "implicit",
    significance: a.significance ?? "",
  }));
}

function coerceSteps(
  raw: SelectionResult["steps"] | null | undefined,
): SelectionAnalysisResult["steps"] {
  if (!raw) return undefined;
  return raw.map((s) => ({
    step_number: s.step_number ?? 0,
    prompt: s.prompt ?? "",
    answer: s.answer ?? "",
    expression: s.answer ?? "",
    explanation: s.explanation ?? "",
    hint: s.hint ?? "",
  }));
}

function projectPartial(
  started: StartedState,
  partial: Partial<SelectionResult> | undefined,
  streaming: boolean,
): SelectionAnalysisResult {
  return {
    action: (partial?.action as string | undefined) ?? started.action,
    selected_text: started.selectedText,
    question: started.question,
    explanation: partial?.body ?? "",
    assumptions: coerceAssumptions(partial?.assumptions),
    starting_point: partial?.starting_point ?? undefined,
    final_result: partial?.final_result ?? undefined,
    steps: coerceSteps(partial?.steps),
    streaming,
    clientKey: started.clientKey,
    model: started.model,
    regions: started.regions,
  };
}

export function useSelectionThread(paperId: string) {
  const { fastModel } = useUserSettings();
  const setSelectionResultForPaper = useStore((s) => s.setSelectionResultForPaper);
  const setSelectionLoadingForPaper = useStore((s) => s.setSelectionLoadingForPaper);
  const upsertSelectionInHistoryForPaper = useStore((s) => s.upsertSelectionInHistoryForPaper);
  const bumpUsageRefresh = useStore((s) => s.bumpUsageRefresh);

  const startedRef = useRef<StartedState | null>(null);
  const lastSerializedRef = useRef<string>("");
  const [error, setError] = useState<Error | undefined>();

  const obj = useObject({
    id: `${paperId}-selection`,
    api: `/api/papers/${paperId}/selection-stream`,
    schema: SelectionResultSchema,
    credentials: "include",
    onError: (err) => {
      const started = startedRef.current;
      if (!started) return;
      const message = describeError(err);
      const errResult: SelectionAnalysisResult = {
        action: started.action,
        selected_text: started.selectedText,
        question: started.question,
        explanation: message,
        streaming: false,
        clientKey: started.clientKey,
        model: started.model,
        regions: started.regions,
      };
      upsertSelectionInHistoryForPaper(paperId, errResult);
      setSelectionResultForPaper(paperId, errResult);
      setError(err instanceof Error ? err : new Error(message));
      setSelectionLoadingForPaper(paperId, false);
      startedRef.current = null;
    },
    onFinish: ({ object, error: finalError }) => {
      const started = startedRef.current;
      if (!started) return;
      const partial = (object ?? undefined) as Partial<SelectionResult> | undefined;
      const hasContent =
        !!partial &&
        ((typeof partial.body === "string" && partial.body.trim().length > 0) ||
          (Array.isArray(partial.steps) && partial.steps.length > 0) ||
          (typeof partial.final_result === "string" &&
            partial.final_result.trim().length > 0));
      if (!hasContent) {
        const message = finalError
          ? describeError(finalError)
          : "The model didn't return a complete answer. Please try again.";
        const errResult: SelectionAnalysisResult = {
          action: started.action,
          selected_text: started.selectedText,
          question: started.question,
          explanation: message,
          streaming: false,
          clientKey: started.clientKey,
          model: started.model,
          regions: started.regions,
        };
        upsertSelectionInHistoryForPaper(paperId, errResult);
        setSelectionResultForPaper(paperId, errResult);
        setError(finalError instanceof Error ? finalError : new Error(message));
        setSelectionLoadingForPaper(paperId, false);
        startedRef.current = null;
        return;
      }
      const result: SelectionAnalysisResult = {
        ...projectPartial(started, partial, false),
        created_at: Date.now(),
      };
      upsertSelectionInHistoryForPaper(paperId, result);
      setSelectionResultForPaper(paperId, result);
      bumpUsageRefresh();
      setSelectionLoadingForPaper(paperId, false);
      startedRef.current = null;
    },
  });

  // Live partial updates → push into the active selection slot so the
  // panel renders text as it streams. Skip if the caller has switched
  // papers / aborted (startedRef.current is null).
  useEffect(() => {
    const started = startedRef.current;
    if (!started) return;
    const partial = obj.object as Partial<SelectionResult> | undefined;
    if (!partial) return;
    const result = projectPartial(started, partial, true);
    const serialized = JSON.stringify({
      explanation: result.explanation,
      assumptions: result.assumptions,
      starting_point: result.starting_point,
      final_result: result.final_result,
      steps: result.steps,
    });
    if (serialized === lastSerializedRef.current) return;
    lastSerializedRef.current = serialized;
    upsertSelectionInHistoryForPaper(paperId, result);
    setSelectionResultForPaper(paperId, result);
  }, [
    obj.object,
    paperId,
    upsertSelectionInHistoryForPaper,
    setSelectionResultForPaper,
  ]);

  const start = useCallback(
    (args: StartArgs) => {
      const trimmed = args.selectedText.trim();
      if (!trimmed) return;

      // Abort any in-flight call before kicking off the next one.
      try {
        obj.stop();
      } catch {
        /* not running */
      }

      const clientKey = newClientKey();
      const started: StartedState = {
        clientKey,
        action: args.action,
        selectedText: trimmed,
        question: args.question,
        model: args.model ?? fastModel,
        regions: args.regions,
      };
      startedRef.current = started;
      lastSerializedRef.current = "";

      const provisional: SelectionAnalysisResult = {
        action: args.action,
        selected_text: trimmed,
        question: args.question,
        explanation: "",
        streaming: true,
        clientKey,
        model: started.model,
        regions: args.regions,
      };
      setError(undefined);
      setSelectionLoadingForPaper(paperId, true);
      upsertSelectionInHistoryForPaper(paperId, provisional);
      setSelectionResultForPaper(paperId, provisional);

      obj.submit({
        action: args.action,
        selected_text: trimmed,
        question: args.question,
        model: started.model,
        regions: args.regions,
        image_base64: args.imageBase64,
      });
    },
    [
      fastModel,
      obj,
      paperId,
      setSelectionLoadingForPaper,
      setSelectionResultForPaper,
      upsertSelectionInHistoryForPaper,
    ],
  );

  const abort = useCallback(() => {
    try {
      obj.stop();
    } catch {
      /* ignore */
    }
    startedRef.current = null;
    setSelectionLoadingForPaper(paperId, false);
  }, [obj, paperId, setSelectionLoadingForPaper]);

  return useMemo(
    () => ({ start, abort, error, isLoading: obj.isLoading }),
    [start, abort, error, obj.isLoading],
  );
}
